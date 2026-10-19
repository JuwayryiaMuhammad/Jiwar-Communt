import { Injectable } from '@nestjs/common';
import { CommunityGatePort, type GateSchedule } from '../../community';
import { nameKey } from '../../core/common/visitor-name';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { BlocklistCore } from '../blocklist/blocklist-core';
import { GateSubjects, type Refusal } from '../entries/subjects';
import { EVENT_EARLY_MS } from '../entries/subjects';
import { LockdownCore, scopeOf } from '../lockdown/lockdown-core';
import { permitReference } from '../permits/permit-core';
import { workRules, type WorkRules } from '../permits/permit-rules';
import { PassTokens } from '../visitors/pass-tokens';
import { longTag, shortTag } from './offline-tags';

// ============================================================================
// What a gate bundle carries (ADR 0057), version 1
// ============================================================================
//
// Ids are references only (`ref`): what the device uploads names them, the
// server resolves them again. Codes, QR tokens, plates and credentials are
// tags (offline-tags.ts). Never a name, a phone, an ID number or anything
// a resident or the management wrote.

/** A visitor pass the gate may let someone in on during the bundle. */
export interface BundlePass {
  ref: string;
  unitCode: string;
  kind: 'one_time' | 'recurring';
  partySize: number;
  /** A one-time pass's people already in, at download. */
  entriesUsed: number;
  /** In less out, at download. */
  inside: number;
  validFrom: string;
  validUntil: string;
  /** A recurring pass's weekly windows, in the compound's zone. */
  schedule: GateSchedule | null;
  code: string;
  qr: string;
  /** The visitor's car, when the host gave one. */
  plate: string | null;
}

/** A worker whose card the gate may let in during the bundle. */
export interface BundleWorker {
  ref: string;
  unitCode: string;
  capacity: string;
  validUntil: string | null;
  /** Weekly windows in the compound's zone; empty for any time (live-in). */
  schedule: GateSchedule;
  inside: number;
  code: string;
  qr: string;
}

/** A plate on the blocklist: a ban refuses it, a watch lets it in, flagged. */
export interface BundlePlate {
  ref: string;
  kind: 'ban' | 'watch';
  plate: string;
}

/** A works permit in force: its contractors come in by its reference and the last four of their ID. */
export interface BundleWorks {
  ref: string;
  reference: string;
  unitCode: string;
  startsAt: string;
  endsAt: string;
  /** The permit's own daily hours, minutes after local midnight. */
  dailyFrom: number | null;
  dailyTo: number | null;
  /** Its work stopped at download (ADR 0053): its workers stay out. */
  stopped: boolean;
  /** How many workers it names (never who). */
  workers: number;
}

/** A move's truck, by its plate. */
export interface BundleMove {
  ref: string;
  reference: string;
  unitCode: string;
  startsAt: string;
  endsAt: string;
  plate: string;
}

/** An event's guests, by plate or by their exact name, while it lets them in. */
export interface BundleEvent {
  ref: string;
  reference: string;
  unitCode: string;
  /** Guests may come from half an hour before the event to its end. */
  guestsFrom: string;
  guestsUntil: string;
  guests: { ref: string; name: string | null; plate: string | null }[];
}

/** A service vehicle inside at download, for its exit. */
export interface BundleServiceVehicle {
  ref: string;
  plate: string;
  kind: string;
}

export interface BundleSections {
  /** The lockdown holding the bundle's gate at download, or null. */
  lockdown: { scope: 'gate' | 'all'; since: string } | null;
  passes: BundlePass[];
  workers: BundleWorker[];
  blocklist: BundlePlate[];
  /**
   * Live resident credentials (ADR 0031): a JWR2 QR names one; offline the
   * device cannot check its mac, so it tells the guard to check an ID.
   */
  residents: string[];
  /** The compound's work days and hours for contractors and moves (ADR 0049). */
  workRules: WorkRules;
  works: BundleWorks[];
  moves: BundleMove[];
  events: BundleEvent[];
  serviceVehicles: BundleServiceVehicle[];
}

export interface BuildContext {
  bundleId: string;
  salt: Buffer;
  issuedAt: Date;
  validUntil: Date;
  gateId: string;
  tenantId: string;
  timezone: string;
}

/** A refusal at download that holds for the bundle's whole life. */
const FOR_GOOD: ReadonlySet<Refusal> = new Set<Refusal>([
  'used',
  'cancelled',
  'expired',
  'host_inactive',
  'banned',
  'suspended',
  'ended',
]);

/**
 * Builds a gate bundle's sections (ADR 0057) in the issuing transaction,
 * which holds the lockdown row and the blocklist lock shared: the snapshot
 * is consistent with every start, end, ban and lift.
 *
 * A pass or a worker refused at download for good (used, cancelled,
 * expired, its host no longer inviting, banned, suspended, ended) is left
 * out; one refused only for now (not yet valid, outside its schedule) is
 * carried with its window and schedule, for the device to judge at the
 * instant. A card that cannot be derived (a random one from before, a
 * rotated pass key) is left out and counted.
 */
@Injectable()
export class BundleBuilder {
  constructor(
    private readonly community: CommunityGatePort,
    private readonly subjects: GateSubjects,
    private readonly passTokens: PassTokens,
    private readonly lockdown: LockdownCore,
    private readonly blocklist: BlocklistCore,
  ) {}

  async build(
    tx: TenantTxClient,
    b: BuildContext,
  ): Promise<{ sections: BundleSections; counts: Record<string, number> }> {
    const live = await this.lockdown.live(tx, b.gateId);
    const passes = await this.passes(tx, b);
    const workers = await this.workers(tx, b);
    const blocklist = (
      await tx.blocklistEntry.findMany({
        where: {
          ...this.blocklist.active(b.issuedAt),
          subject: 'plate',
          plateKey: { not: null },
        },
        select: { id: true, kind: true, plateKey: true },
        orderBy: { id: 'asc' },
      })
    ).map((e): BundlePlate => ({
      ref: e.id,
      kind: e.kind as 'ban' | 'watch',
      plate: shortTag(b.salt, 'plate', e.plateKey!),
    }));
    // A credential lives while its account lives somewhere (ADR 0031:
    // every hook that ends a residence revokes them).
    const residents = (
      await tx.entryCredential.findMany({
        where: { revokedAt: null, account: { status: 'active' } },
        select: { id: true },
        orderBy: { id: 'asc' },
      })
    ).map((c) => longTag(b.bundleId, 'resident-credential', c.id));
    const permits = await this.permits(tx, b);
    const serviceVehicles = (
      await tx.serviceVehicleVisit.findMany({
        where: { exitedAt: null, plateKey: { not: null } },
        select: { id: true, plateKey: true, kind: true },
        orderBy: { id: 'asc' },
      })
    ).map((v): BundleServiceVehicle => ({
      ref: v.id,
      plate: shortTag(b.salt, 'plate', v.plateKey!),
      kind: v.kind,
    }));
    return {
      sections: {
        lockdown: live
          ? { scope: scopeOf(live), since: live.startedAt.toISOString() }
          : null,
        passes: passes.items,
        workers: workers.items,
        blocklist,
        residents,
        workRules: workRules(
          await tx.permitSettings.findUniqueOrThrow({
            where: { tenantId: b.tenantId },
          }),
        ),
        ...permits,
        serviceVehicles,
      },
      counts: {
        passes: passes.items.length,
        passesNotDerivable: passes.notDerivable,
        workers: workers.items.length,
        workersNotDerivable: workers.notDerivable,
        blocklist: blocklist.length,
        residents: residents.length,
        works: permits.works.length,
        moves: permits.moves.length,
        events: permits.events.length,
        serviceVehicles: serviceVehicles.length,
      },
    };
  }

  private async passes(
    tx: TenantTxClient,
    b: BuildContext,
  ): Promise<{ items: BundlePass[]; notDerivable: number }> {
    const rows = await tx.visitorPass.findMany({
      where: {
        status: 'active',
        validFrom: { lt: b.validUntil },
        validUntil: { gt: b.issuedAt },
      },
      include: { visitorDetails: { select: { plateKey: true } } },
      orderBy: { id: 'asc' },
    });
    const inside = await this.insideOf(
      tx,
      'visitor_pass',
      rows.map((r) => r.id),
    );
    const items: BundlePass[] = [];
    let notDerivable = 0;
    for (const p of rows) {
      const refusal = await this.subjects.refusal(
        tx,
        await this.subjects.pass(tx, p),
        b.issuedAt,
        b.timezone,
      );
      if (refusal && FOR_GOOD.has(refusal)) continue;
      const secret = this.passTokens.liveSecret(p);
      if (!secret) {
        notDerivable++;
        continue;
      }
      items.push({
        ref: p.id,
        unitCode: await this.community.unitCode(tx, p.unitId),
        kind: p.kind,
        partySize: p.partySize,
        entriesUsed: p.entriesUsed,
        inside: inside.get(p.id) ?? 0,
        validFrom: p.validFrom.toISOString(),
        validUntil: p.validUntil.toISOString(),
        schedule:
          p.kind === 'recurring'
            ? (p.schedule as unknown as GateSchedule)
            : null,
        code: shortTag(b.salt, 'visitor-code', secret.code),
        qr: longTag(b.bundleId, 'visitor-qr', secret.token),
        plate: p.visitorDetails?.plateKey
          ? shortTag(b.salt, 'plate', p.visitorDetails.plateKey)
          : null,
      });
    }
    return { items, notDerivable };
  }

  private async workers(
    tx: TenantTxClient,
    b: BuildContext,
  ): Promise<{ items: BundleWorker[]; notDerivable: number }> {
    const { cards, notDerivable } = await this.community.offlineCards(tx);
    const inside = await this.insideOf(
      tx,
      'worker_engagement',
      cards.map((c) => c.engagement.engagementId),
    );
    const items: BundleWorker[] = [];
    for (const c of cards) {
      const e = c.engagement;
      const refusal = await this.subjects.refusal(
        tx,
        this.subjects.worker(e),
        b.issuedAt,
        b.timezone,
      );
      if (refusal && FOR_GOOD.has(refusal)) continue;
      items.push({
        ref: e.engagementId,
        unitCode: e.unitCode,
        capacity: e.capacity,
        validUntil: e.validUntil?.toISOString() ?? null,
        schedule: e.schedule,
        inside: inside.get(e.engagementId) ?? 0,
        code: shortTag(b.salt, 'worker-code', c.code),
        qr: longTag(b.bundleId, 'worker-qr', c.token),
      });
    }
    return { items, notDerivable };
  }

  /**
   * The approved permits in force during the bundle (ADR 0049): works by
   * reference, moves by their truck's plate, events by their guests' plates
   * and exact names, from half an hour before. Never a name in clear.
   */
  private async permits(
    tx: TenantTxClient,
    b: BuildContext,
  ): Promise<{
    works: BundleWorks[];
    moves: BundleMove[];
    events: BundleEvent[];
  }> {
    const rows = await tx.unitPermit.findMany({
      where: {
        status: 'approved',
        kind: { in: ['works', 'move', 'event'] },
        startsAt: { lt: new Date(b.validUntil.getTime() + EVENT_EARLY_MS) },
        endsAt: { gt: b.issuedAt },
      },
      orderBy: { id: 'asc' },
    });
    const codes = await this.community.unitCodes(
      tx,
      rows.map((r) => r.unitId),
    );
    const works: BundleWorks[] = [];
    const moves: BundleMove[] = [];
    const events: BundleEvent[] = [];
    for (const p of rows) {
      const common = {
        ref: p.id,
        reference: permitReference(p.kind, p.number),
        unitCode: codes.get(p.unitId)!,
      };
      if (p.kind === 'works') {
        if (p.startsAt >= b.validUntil) continue;
        works.push({
          ...common,
          startsAt: p.startsAt.toISOString(),
          endsAt: p.endsAt.toISOString(),
          dailyFrom: p.dailyFrom,
          dailyTo: p.dailyTo,
          stopped:
            (await tx.permitWorkStop.count({
              where: { permitId: p.id, endedAt: null },
            })) > 0,
          workers: await tx.permitWorker.count({
            where: { permitId: p.id, removedAt: null, purgedAt: null },
          }),
        });
      } else if (p.kind === 'move') {
        if (p.startsAt >= b.validUntil || !p.plateKey) continue;
        moves.push({
          ...common,
          startsAt: p.startsAt.toISOString(),
          endsAt: p.endsAt.toISOString(),
          plate: shortTag(b.salt, 'plate', p.plateKey),
        });
      } else {
        const guests = await tx.permitGuest.findMany({
          where: { permitId: p.id, removedAt: null, purgedAt: null },
          select: { id: true, fullName: true, plateKey: true },
          orderBy: { id: 'asc' },
        });
        events.push({
          ...common,
          guestsFrom: new Date(
            p.startsAt.getTime() - EVENT_EARLY_MS,
          ).toISOString(),
          guestsUntil: p.endsAt.toISOString(),
          guests: guests.map((g) => {
            const key = g.fullName ? nameKey(g.fullName) : null;
            return {
              ref: g.id,
              name: key ? shortTag(b.salt, 'guest-name', key) : null,
              plate: g.plateKey ? shortTag(b.salt, 'plate', g.plateKey) : null,
            };
          }),
        });
      }
    }
    return { works, moves, events };
  }

  /** In less out per subject, over the whole log (ADR 0043: inside is a count). */
  private async insideOf(
    tx: TenantTxClient,
    type: 'visitor_pass' | 'worker_engagement',
    ids: readonly string[],
  ): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = await tx.$queryRaw<{ subject_id: string; inside: number }[]>`
      SELECT subject_id::text AS subject_id,
             (count(*) FILTER (WHERE direction = 'in')
              - count(*) FILTER (WHERE direction = 'out'))::int AS inside
        FROM gate_entries
       WHERE subject_type = ${type}::gate_subject_type
         AND subject_id = ANY(${[...ids]}::uuid[])
       GROUP BY subject_id`;
    return new Map(rows.map((r) => [r.subject_id, r.inside]));
  }
}
