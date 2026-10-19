import { Injectable } from '@nestjs/common';
import { CommunityGatePort, type GateSchedule } from '../../community';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { BlocklistCore } from '../blocklist/blocklist-core';
import { GateSubjects, type Refusal } from '../entries/subjects';
import { LockdownCore, scopeOf } from '../lockdown/lockdown-core';
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
    return {
      sections: {
        lockdown: live
          ? { scope: scopeOf(live), since: live.startedAt.toISOString() }
          : null,
        passes: passes.items,
        workers: workers.items,
        blocklist,
        residents,
      },
      counts: {
        passes: passes.items.length,
        passesNotDerivable: passes.notDerivable,
        workers: workers.items.length,
        workersNotDerivable: workers.notDerivable,
        blocklist: blocklist.length,
        residents: residents.length,
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
