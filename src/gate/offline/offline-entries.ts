import { Injectable } from '@nestjs/common';
import type { GateEntryMethod } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { RequestContext } from '../../core/common/cls/request-context';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { Notifier } from '../../core/notifications/notifier';
import { BlocklistMatcher } from '../blocklist/blocklist-matcher';
import { EntriesService } from '../entries/entries.service';
import { GateSubjects, type GateSubject } from '../entries/subjects';
import { OfflineFlags, type NewFlag } from './offline-flags.service';
import { refusalFlag, type EntryAction, type FlagKind } from './offline-rules';

/** The permits' subjects come in on the permit (ADR 0049). */
const PERMIT_SUBJECTS: readonly string[] = [
  'permit_worker',
  'event_guest',
  'move_permit',
];

/** Where and by whom an offline entry happened: its bundle's. */
export interface OfflineEntryContext {
  action: EntryAction;
  occurredAt: Date;
  gateId: string;
  gateName: string;
  shiftId: string;
  guardId: string;
  timezone: string;
}

export type OfflineEntryOutcome =
  | { entryId: string; flags: Omit<NewFlag, 'batchId' | 'deviceId'>[] }
  | { rejection: 'subject_unknown' };

/**
 * An entry or an exit a device recorded offline (ADR 0057), recorded at
 * sync as it happened: never refused, since it did. What the server knows
 * better becomes a flag:
 *
 * - a lockdown that held the gate at that instant: `lockdown_entered`;
 * - a plate banned or watched now or then: `blocklist_ban_entered`,
 *   `blocklist_watch_entered` (the keepers told by the blocklist itself);
 * - a refusal at that instant, judged on what is known now
 *   (offline-rules.ts `refusalFlag`), a pass cancelled after it excepted;
 * - a one-time pass already full: `once_only_reused`, and the counter
 *   stays at its party size (its CHECK holds); one cancelled or expired
 *   since keeps its counter closed, and is judged full by its entries in;
 * - more inside than a recurring pass allows: `capacity_exceeded`; a
 *   worker already inside: `already_inside`;
 * - an exit with nobody inside: `exit_without_entry`, cleared when the
 *   entry it closes arrives.
 *
 * The entry's id is the app's own (the action's client id): an action the
 * device also sent online, whose answer it lost, is that entry already.
 *
 * The caller holds the account, the bundle's shift, the device and the
 * lockdown row; the blocklist's shared lock is taken here, then the
 * subject's row, as an online entry does (ADR 0053's lock order).
 */
@Injectable()
export class OfflineEntries {
  constructor(
    private readonly ctx: RequestContext,
    private readonly entries: EntriesService,
    private readonly subjects: GateSubjects,
    private readonly matcher: BlocklistMatcher,
    private readonly community: CommunityGatePort,
    private readonly notifier: Notifier,
    private readonly flagsOf: OfflineFlags,
  ) {}

  async record(
    tx: TenantTxClient,
    e: OfflineEntryContext,
  ): Promise<OfflineEntryOutcome> {
    const a = e.action;
    const known = await tx.gateEntry.findUnique({ where: { id: a.clientId } });
    if (known) return { entryId: known.id, flags: [] };
    const found = await this.subjects.byId(tx, a.subjectType, a.subjectId);
    if (!found) return { rejection: 'subject_unknown' };
    const flags: FlagKind[] = [];
    const extra: Record<string, string | number> = {};
    let method: GateEntryMethod = 'guard';
    if (a.direction === 'in') {
      // The lockdown row is the caller's (FOR SHARE): one that held the
      // gate at that instant, by its own times.
      if (await this.lockdownAt(tx, e.gateId, e.occurredAt))
        flags.push('lockdown_entered');
      // Then the blocklist, shared, before the subject's row.
      const met = await this.matcher.atSync(
        tx,
        a.subjectType,
        a.subjectId,
        e.occurredAt,
        { gateId: e.gateId, shiftId: e.shiftId },
      );
      if (met)
        flags.push(
          met.kind === 'ban'
            ? 'blocklist_ban_entered'
            : 'blocklist_watch_entered',
        );
    }
    await this.entries.lockSubject(tx, found.type, found.id);
    // Read again under the lock: what the counter and the refusal see.
    const subject = (await this.subjects.byId(tx, found.type, found.id))!;
    const inside = await this.entries.insideCount(tx, subject.type, subject.id);
    if (a.direction === 'in') {
      const refusal = await this.subjects.refusal(
        tx,
        asAt(subject, e.occurredAt),
        e.occurredAt,
        e.timezone,
      );
      const flag = refusalFlag(refusal);
      if (flag) {
        flags.push(flag);
        extra.reason = refusal!;
      }
      const pass = subject.pass;
      if (pass?.kind === 'one_time' && pass.status !== 'active') {
        // Cancelled, expired or used since: its counter is closed (its
        // CHECK ties `used` to a full count), so the log's entries in say
        // whether it was used up.
        const ins = await tx.gateEntry.count({
          where: {
            subjectType: 'visitor_pass',
            subjectId: pass.id,
            direction: 'in',
          },
        });
        if (Math.max(ins, pass.entriesUsed) >= pass.partySize)
          flags.push('once_only_reused');
      } else if (pass?.kind === 'one_time') {
        if (pass.entriesUsed >= pass.partySize) flags.push('once_only_reused');
        else {
          const entriesUsed = pass.entriesUsed + 1;
          await tx.visitorPass.update({
            where: { id: pass.id },
            data:
              entriesUsed < pass.partySize
                ? { entriesUsed }
                : {
                    entriesUsed,
                    status: 'used',
                    usedAt: e.occurredAt,
                    codeHash: null,
                    qrTokenHash: null,
                  },
          });
        }
      } else if (pass && inside >= pass.partySize)
        flags.push('capacity_exceeded');
      else if (!pass && inside >= 1) flags.push('already_inside');
      method = PERMIT_SUBJECTS.includes(subject.type)
        ? 'permit'
        : a.via === 'qr'
          ? 'qr'
          : 'code';
    } else if (inside <= 0) flags.push('exit_without_entry');
    const entry = await this.entries.insert(tx, {
      id: a.clientId,
      tenantId: this.ctx.txTenantId,
      gateId: e.gateId,
      shiftId: e.shiftId,
      guardAccountId: e.guardId,
      subject,
      direction: a.direction,
      method,
      occurredAt: e.occurredAt,
      unconfirmed: false,
      approvalRequestId: null,
    });
    const of = () => ({ type: subject.type, id: subject.id });
    if (subject.engagement) {
      // The household knows when its worker comes and goes (ADR 0028),
      // late as it is.
      const holders = await this.community.holders(
        tx,
        subject.unitId,
        'visitorsNotify',
      );
      await this.notifier.notify(tx, holders, {
        kind: a.direction === 'in' ? 'worker.entered' : 'worker.exited',
        params: {
          unitCode: subject.unitCode,
          gateName: e.gateName,
          workerName: subject.engagement.workerName,
        },
        targetId: subject.id,
      });
    }
    // An entry that came before an exit flagged as without one closes it.
    if (a.direction === 'in')
      await this.flagsOf.reconcile(tx, of(), e.occurredAt);
    return {
      entryId: entry.id,
      flags: flags.map((kind) => ({
        kind,
        subject: of(),
        gateId: e.gateId,
        shiftId: e.shiftId,
        params:
          kind === 'credential_revoked' ||
          kind === 'credential_banned' ||
          kind === 'invalid_at_time'
            ? extra
            : {},
      })),
    };
  }

  /** A lockdown that held the gate at `at`, by its own start and end. */
  async lockdownAt(
    tx: TenantTxClient,
    gateId: string,
    at: Date,
  ): Promise<boolean> {
    return (
      (await tx.gateLockdown.count({
        where: {
          OR: [{ gateId }, { gateId: null }],
          startedAt: { lte: at },
          AND: [{ OR: [{ endedAt: null }, { endedAt: { gt: at } }] }],
        },
      })) > 0
    );
  }
}

/**
 * The subject as it stood at `at`, for its refusal: a pass cancelled after
 * it, or marked expired or used after it, was active then (its window and
 * its counter decide the rest).
 */
function asAt(s: GateSubject, at: Date): GateSubject {
  const p = s.pass;
  if (!p) return s;
  const activeThen =
    p.status === 'used' ||
    (p.status === 'expired' && at < p.validUntil) ||
    (p.status === 'cancelled' && p.cancelledAt !== null && p.cancelledAt > at);
  return activeThen ? { ...s, pass: { ...p, status: 'active' } } : s;
}
