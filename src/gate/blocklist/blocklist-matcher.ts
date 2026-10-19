import { Injectable } from '@nestjs/common';
import type { BlocklistEntry, Prisma } from '@prisma/client';
import { IdentifierHasher } from '../../core/auth/identifier';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { normalizeIdNumber } from '../../core/common/id-number';
import { newId } from '../../core/common/uuid';
import { plateKey } from '../../core/common/vehicle-plate';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';
import { BlocklistCore } from './blocklist-core';

/** Where the blocklist met someone (ADR 0053). */
export type MatchSource =
  | 'visitor_pass'
  | 'move_permit'
  | 'event_guest'
  | 'gate_request'
  | 'verify'
  | 'entry'
  | 'plate_lookup'
  | 'id_lookup'
  // A field exception's visitor or vehicle, a service vehicle (ADR 0056).
  | 'field_exception'
  | 'service_vehicle'
  // An offline entry's plate, met when its device synced (ADR 0057).
  | 'offline_sync';

/** The gate subject it met, when there is one. */
export interface MatchSubject {
  type:
    | 'visitor_pass'
    | 'gate_request'
    | 'event_guest'
    | 'move_permit'
    | 'field_exception'
    | 'service_vehicle';
  id: string;
}

export interface MatchAt {
  source: MatchSource;
  /** refused: kept out; flagged: let in, watched; noted: met on a record or a lookup. */
  outcome: 'refused' | 'flagged' | 'noted';
  subject?: MatchSubject;
  gateId?: string | null;
  shiftId?: string | null;
}

/** What a check found: every live entry, and the strongest of them. */
export interface BlocklistHit {
  entries: BlocklistEntry[];
  /** `ban` when any is a ban, else `watch`; null for none. */
  kind: 'ban' | 'watch' | null;
  /** The entry that decides: the first ban, else the first watch. */
  entry: BlocklistEntry | null;
}

export const entryBlocked = () =>
  appError.conflict(ErrorCode.ENTRY_BLOCKED, 'Security does not let them in');

/**
 * The blocklist at the gate (ADR 0053): wherever a plate or a full ID
 * number is recorded or looked up, it is matched here, under the
 * compound's blocklist lock taken shared (BlocklistCore), so a ban added at
 * the same moment either committed first and is seen, or waits for this
 * check's transaction to end.
 *
 * A match is recorded (`blocklist_matches`, the keepers' log) and the
 * keepers are told (`blocklist.ban_matched` or `.watch_matched`, with where
 * only). A household whose visitor, guest or truck was refused is told
 * once that security refused them — never why (`security_refusals`).
 */
@Injectable()
export class BlocklistMatcher {
  constructor(
    private readonly ctx: RequestContext,
    private readonly core: BlocklistCore,
    private readonly hasher: IdentifierHasher,
    private readonly safety: SafetyCore,
  ) {}

  /**
   * The live entries for these plates and ID numbers (as typed: each is
   * normalized here; one that does not normalize matches nothing), under
   * the shared lock. With nothing to look for, no lock and no query.
   */
  async check(
    tx: TenantTxClient,
    q: {
      plates?: readonly (string | null | undefined)[];
      idNumbers?: readonly (string | null | undefined)[];
    },
  ): Promise<BlocklistHit> {
    const keys = [
      ...new Set(
        (q.plates ?? [])
          .filter((p): p is string => !!p)
          .map((p) => plateKey(p)),
      ),
    ];
    const hashes = [
      ...new Set(
        (q.idNumbers ?? [])
          .map((n) => (n ? normalizeIdNumber(n) : null))
          .filter((n): n is string => n !== null)
          .map((n) => this.hasher.hashBlocklistId(this.ctx.txTenantId, n)),
      ),
    ];
    if (!keys.length && !hashes.length)
      return { entries: [], kind: null, entry: null };
    await this.core.lockRead(tx);
    const now = await dbNow(tx);
    const which: Prisma.BlocklistEntryWhereInput[] = [
      ...(keys.length ? [{ subject: 'plate', plateKey: { in: keys } }] : []),
      ...(hashes.length ? [{ subject: 'person', idHash: { in: hashes } }] : []),
    ];
    const entries = await tx.blocklistEntry.findMany({
      where: { AND: [this.core.active(now), { OR: which }] },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const ban = entries.find((e) => e.kind === 'ban') ?? null;
    const entry = ban ?? entries[0] ?? null;
    return {
      entries,
      kind: entry ? (entry.kind as 'ban' | 'watch') : null,
      entry,
    };
  }

  /**
   * Records each entry met, and tells the keepers, in the caller's
   * transaction. The one who acted is never told.
   */
  async record(
    tx: TenantTxClient,
    hit: BlocklistHit,
    at: MatchAt,
  ): Promise<void> {
    if (!hit.entries.length) return;
    const tenantId = this.ctx.txTenantId;
    const actor = this.ctx.accountId;
    await tx.blocklistMatch.createMany({
      data: hit.entries.map((e) => ({
        id: newId(),
        tenantId,
        entryId: e.id,
        kind: e.kind,
        source: at.source,
        subjectType: at.subject?.type ?? null,
        subjectId: at.subject?.id ?? null,
        gateId: at.gateId ?? null,
        shiftId: at.shiftId ?? null,
        actorAccountId: actor,
        outcome: at.outcome,
      })),
    });
    const keepers = await this.safety.holding(tx, 'blocklist.manage');
    for (const e of hit.entries)
      await this.safety.notify(
        tx,
        keepers,
        e.kind === 'ban' ? 'blocklist.ban_matched' : 'blocklist.watch_matched',
        e.id,
        { source: at.source },
        actor,
      );
  }

  /**
   * An entry in, or a verify, at the gate (ADR 0053): the plate the subject carries — a
   * pass's visitor, a gate request's visitor, an event guest's car, a
   * move's truck — checked, and what was met recorded (refused for a ban,
   * flagged for a watch); the household told once of a refusal. Null when
   * the subject carries no plate.
   */
  async atGate(
    tx: TenantTxClient,
    source: 'entry' | 'verify',
    subjectType: string,
    subjectId: string,
    shift: { id: string; gateId: string },
  ): Promise<BlocklistHit | null> {
    const carried = await this.carried(tx, subjectType, subjectId);
    if (!carried?.plate) return null;
    const hit = await this.check(tx, { plates: [carried.plate] });
    if (!hit.kind) return hit;
    await this.record(tx, hit, {
      source,
      outcome: hit.kind === 'ban' ? 'refused' : 'flagged',
      subject: carried.subject,
      gateId: shift.gateId,
      shiftId: shift.id,
    });
    if (hit.kind === 'ban' && carried.household)
      await this.refusedOnce(
        tx,
        carried.household.subject,
        carried.household.accountId,
        carried.household.target,
      );
    return hit;
  }

  /**
   * An offline entry in at `at`, met when its device synced (ADR 0057):
   * the plate the subject carries, against the entries live now or at the
   * instant it came in — a ban added after the bundle, or after the entry
   * with them still inside. Recorded as flagged (it was let in) with the
   * keepers told; never the household. Null when nothing is met.
   */
  async atSync(
    tx: TenantTxClient,
    subjectType: string,
    subjectId: string,
    at: Date,
    where: { gateId: string; shiftId: string },
  ): Promise<BlocklistHit | null> {
    const carried = await this.carried(tx, subjectType, subjectId);
    if (!carried?.plate) return null;
    return this.plateAtSync(tx, plateKey(carried.plate), at, {
      ...where,
      subject: carried.subject,
    });
  }

  /**
   * A plate's key met at sync (ADR 0057): a service vehicle's, or the plate
   * a subject carries. The entries live now or at `at`, recorded as
   * flagged with the keepers told. Null when nothing is met.
   */
  async plateAtSync(
    tx: TenantTxClient,
    key: string,
    at: Date,
    where: { gateId: string; shiftId: string; subject?: MatchSubject },
  ): Promise<BlocklistHit | null> {
    await this.core.lockRead(tx);
    const now = await dbNow(tx);
    const entries = await tx.blocklistEntry.findMany({
      where: {
        subject: 'plate',
        plateKey: key,
        OR: [this.core.active(now), this.core.activeAt(at)],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (!entries.length) return null;
    const entry = entries.find((e) => e.kind === 'ban') ?? entries[0];
    const hit: BlocklistHit = {
      entries,
      kind: entry.kind as 'ban' | 'watch',
      entry,
    };
    await this.record(tx, hit, {
      source: 'offline_sync',
      outcome: 'flagged',
      ...(where.subject ? { subject: where.subject } : {}),
      gateId: where.gateId,
      shiftId: where.shiftId,
    });
    return hit;
  }

  /** What a gate subject carries to the blocklist, and whose it is. */
  async carried(
    tx: TenantTxClient,
    subjectType: string,
    subjectId: string,
  ): Promise<{
    plate: string | null;
    subject: MatchSubject;
    household: {
      subject: {
        type: 'visitor_pass' | 'event_guest' | 'move_permit';
        id: string;
      };
      accountId: string;
      target: { kind: 'visitor_pass' | 'unit_permit'; id: string };
    } | null;
  } | null> {
    switch (subjectType) {
      case 'visitor_pass': {
        const p = await tx.visitorPass.findUnique({
          where: { id: subjectId },
          include: { visitorDetails: { select: { vehiclePlate: true } } },
        });
        if (!p) return null;
        return {
          plate: p.visitorDetails?.vehiclePlate ?? null,
          subject: { type: 'visitor_pass', id: p.id },
          household: {
            subject: { type: 'visitor_pass', id: p.id },
            accountId: p.hostAccountId,
            target: { kind: 'visitor_pass', id: p.id },
          },
        };
      }
      case 'gate_request': {
        const r = await tx.gateApprovalRequest.findUnique({
          where: { id: subjectId },
          select: { id: true, visitorDetailsId: true },
        });
        if (!r?.visitorDetailsId) return null;
        const d = await tx.visitorDetails.findUnique({
          where: { id: r.visitorDetailsId },
          select: { vehiclePlate: true },
        });
        return {
          plate: d?.vehiclePlate ?? null,
          subject: { type: 'gate_request', id: r.id },
          // The household was asked, and decided: nobody to tell again.
          household: null,
        };
      }
      case 'field_exception': {
        // A visitor's or a vehicle's (ADR 0056): the plate the guard gave.
        const e = await tx.gateFieldException.findUnique({
          where: { id: subjectId },
          select: { id: true, visitorDetailsId: true },
        });
        if (!e?.visitorDetailsId) return null;
        const d = await tx.visitorDetails.findUnique({
          where: { id: e.visitorDetailsId },
          select: { vehiclePlate: true },
        });
        return {
          plate: d?.vehiclePlate ?? null,
          subject: { type: 'field_exception', id: e.id },
          // The management decided it: no household to tell.
          household: null,
        };
      }
      case 'event_guest': {
        const g = await tx.permitGuest.findUnique({ where: { id: subjectId } });
        if (!g) return null;
        const p = await tx.unitPermit.findUniqueOrThrow({
          where: { id: g.permitId },
          select: { requestedById: true },
        });
        return {
          plate: g.vehiclePlate,
          subject: { type: 'event_guest', id: g.id },
          household: {
            subject: { type: 'event_guest', id: g.id },
            accountId: p.requestedById,
            target: { kind: 'unit_permit', id: g.permitId },
          },
        };
      }
      case 'move_permit': {
        const p = await tx.unitPermit.findUnique({ where: { id: subjectId } });
        if (!p) return null;
        return {
          plate: p.truckPlate,
          subject: { type: 'move_permit', id: p.id },
          household: {
            subject: { type: 'move_permit', id: p.id },
            accountId: p.requestedById,
            target: { kind: 'unit_permit', id: p.id },
          },
        };
      }
      default:
        // Workers and contractors carry no plate here.
        return null;
    }
  }

  /**
   * A plate recorded by a resident (ADR 0053): a pass's visitor, a move's
   * truck, an event's guest. Checked and, when met, noted for the keepers
   * — never refused here, so a resident never learns a plate is listed.
   */
  async noteRecorded(
    tx: TenantTxClient,
    source: 'visitor_pass' | 'move_permit' | 'event_guest',
    subject: MatchSubject,
    plate: string | null | undefined,
  ): Promise<void> {
    if (!plate) return;
    const hit = await this.check(tx, { plates: [plate] });
    await this.record(tx, hit, { source, outcome: 'noted', subject });
  }

  /**
   * The household told, once per subject, that security refused it: the
   * pass's host, or the permit's requester. True when this was the first.
   */
  async refusedOnce(
    tx: TenantTxClient,
    subject: {
      type: 'visitor_pass' | 'event_guest' | 'move_permit';
      id: string;
    },
    household: string,
    target: { kind: 'visitor_pass' | 'unit_permit'; id: string },
  ): Promise<boolean> {
    const first = await tx.$queryRaw<{ subject_id: string }[]>`
      INSERT INTO security_refusals (tenant_id, subject_type, subject_id)
      VALUES (${this.ctx.txTenantId}::uuid, ${subject.type}, ${subject.id}::uuid)
      ON CONFLICT DO NOTHING
      RETURNING subject_id`;
    if (!first.length) return false;
    await this.safety.notify(
      tx,
      [household],
      target.kind === 'visitor_pass'
        ? 'visitor_pass.refused_by_security'
        : 'unit_permit.refused_by_security',
      target.id,
    );
    return true;
  }
}
