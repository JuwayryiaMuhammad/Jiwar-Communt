import { Injectable } from '@nestjs/common';
import type { WorkerCapacity, WorkerEngagementStatus } from '@prisma/client';
import { IdentifierHasher } from '../core/auth/identifier';
import type { FieldError } from '../core/common/errors';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import type { Capabilities } from './capabilities/capabilities';
import {
  CapabilitiesService,
  type CapabilityFlag,
} from './capabilities/capabilities.service';

export type { CapabilityFlag };
import {
  HouseholdAuthority,
  isPrimary,
} from './households/household-authority';
import { CommunityEngagementPort } from './engagement-port';
import { ReviewFlags } from './units/review-flags';
import { lockUnits } from './units/unit-lock';
import { EngagementTokens } from './workers/engagement-tokens';
import { WorkersAuthority } from './workers/workers-authority';
import {
  checkSchedule,
  isWithinSchedule,
  type WorkerSchedule,
} from './workers/schedule';

/** A weekly schedule: days 0–6 and windows in the compound's time zone. */
export type GateSchedule = WorkerSchedule;

/** A domestic worker's engagement, as the gate needs it (ADR 0017, 0028). */
export interface GateEngagement {
  engagementId: string;
  unitId: string;
  unitCode: string;
  workerName: string;
  capacity: WorkerCapacity;
  status: WorkerEngagementStatus;
  schedule: GateSchedule;
  validUntil: Date | null;
  banned: boolean;
  suspendedByManagement: boolean;
  /** The worker's photo file (ADR 0029): the guard compares the face. */
  photoFileId: string | null;
}

/** One of a unit's minors (ADR 0054): a membership without an account. */
export interface UnitMinor {
  memberId: string;
  unitId: string;
  fullName: string;
  birthDate: Date;
}

/** Someone who lives in a unit, and as what (ADR 0047). */
export interface UnitResident {
  accountId: string;
  role: 'owner' | 'tenant' | 'member';
  isPrimary: boolean;
}

const ENGAGEMENT = {
  worker: { select: { fullName: true, bannedAt: true, photoFileId: true } },
  unit: { select: { code: true } },
} as const;

/**
 * What the gate domain reads from the community domain (ADR 0015, 0028),
 * and nothing else: units, who may do what on a unit (capabilitiesFor), the
 * household's authority and the schedule rules. Every method takes the
 * gate's transaction, so the answer is consistent with the gate's write.
 */
@Injectable()
export class CommunityGatePort {
  constructor(
    private readonly capabilities: CapabilitiesService,
    private readonly household: HouseholdAuthority,
    private readonly hasher: IdentifierHasher,
    private readonly workers: WorkersAuthority,
    private readonly engagement: CommunityEngagementPort,
    private readonly flags: ReviewFlags,
    private readonly cardTokens: EngagementTokens,
  ) {}

  /**
   * Every active account with a place in the compound now (ADR 0053, the
   * lockdown's notice): the people of every household and the landlords,
   * as a whole-compound announcement reaches them (ADR 0040). Ids only.
   */
  async everyone(tx: TenantTxClient): Promise<string[]> {
    const places = await this.engagement.members(tx, {
      buildings: null,
      occupancy: 'everyone',
    });
    return [...new Set(places.map((p) => p.accountId))].sort();
  }

  /**
   * The unit's active minors (ADR 0054), oldest first. Whether one has come
   * of age by the compound's day is the caller's to judge (`birthDate`).
   */
  async minors(tx: TenantTxClient, unitId: string): Promise<UnitMinor[]> {
    const rows = await tx.householdMember.findMany({
      where: { unitId, status: 'active', isMinor: true },
      select: { id: true, unitId: true, fullName: true, birthDate: true },
      orderBy: [{ birthDate: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toMinor);
  }

  /**
   * One of the unit's active minors, read FOR SHARE: a removal or a coming
   * of age waits for the write naming them (ADR 0054). Null otherwise.
   */
  async minorOf(
    tx: TenantTxClient,
    unitId: string,
    memberId: string,
  ): Promise<UnitMinor | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM household_members
       WHERE id = ${memberId}::uuid AND unit_id = ${unitId}::uuid
         AND status = 'active' AND is_minor
         FOR SHARE`;
    if (!rows.length) return null;
    const m = await tx.householdMember.findUniqueOrThrow({
      where: { id: memberId },
      select: { id: true, unitId: true, fullName: true, birthDate: true },
    });
    return toMinor(m);
  }

  /** Members by id, as minors of their unit, whatever their status now. */
  async minorsById(
    tx: TenantTxClient,
    memberIds: readonly string[],
  ): Promise<Map<string, UnitMinor & { active: boolean }>> {
    if (!memberIds.length) return new Map();
    const rows = await tx.householdMember.findMany({
      where: { id: { in: [...new Set(memberIds)] }, isMinor: true },
      select: {
        id: true,
        unitId: true,
        fullName: true,
        birthDate: true,
        status: true,
      },
    });
    return new Map(
      rows.map((m) => [m.id, { ...toMinor(m), active: m.status === 'active' }]),
    );
  }

  /**
   * Refused under a death review (403 HOUSEHOLD_UNDER_REVIEW, ADR 0021):
   * what adds to the household's arrangements waits for the management.
   */
  assertHouseholdMutable(tx: TenantTxClient, unitId: string): Promise<void> {
    return this.flags.assertMutable(tx, unitId);
  }

  /**
   * Whether the caller may follow this engagement: its requester, the
   * unit's primary, a `workers` delegate or a manager (WorkersAuthority,
   * which also refuses with its own codes). False when it does not exist.
   */
  async authorizeEngagement(
    tx: TenantTxClient,
    engagementId: string,
  ): Promise<boolean> {
    const e = await tx.workerEngagement.findUnique({
      where: { id: engagementId },
    });
    if (!e) return false;
    await this.workers.forEngagement(tx, e);
    return true;
  }

  async unitByCode(
    tx: TenantTxClient,
    code: string,
  ): Promise<{ id: string; code: string } | null> {
    return tx.unit.findFirst({
      where: { code: code.trim() },
      select: { id: true, code: true },
    });
  }

  /**
   * Every active account whose capabilities on the unit carry `flag`: the
   * people to tell (ADR 0020 decides, never the gate).
   */
  holders(
    tx: TenantTxClient,
    unitId: string,
    flag: CapabilityFlag,
  ): Promise<string[]> {
    return this.capabilities.holders(tx, unitId, flag);
  }

  /**
   * Whether `memberId` is an active member of the unit's household (ADR
   * 0047: whom accessibility help is for), a minor without an account
   * included. Read FOR SHARE: a removal waits for the request naming them.
   */
  async isActiveMember(
    tx: TenantTxClient,
    unitId: string,
    memberId: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM household_members
       WHERE id = ${memberId}::uuid AND unit_id = ${unitId}::uuid
         AND status = 'active'
         FOR SHARE`;
    return rows.length > 0;
  }

  /** Household members' first names (ADR 0047), null for an erased one. */
  async memberFirstNames(
    tx: TenantTxClient,
    memberIds: readonly string[],
  ): Promise<Map<string, string | null>> {
    if (!memberIds.length) return new Map();
    const members = await tx.householdMember.findMany({
      where: { id: { in: [...new Set(memberIds)] } },
      select: { id: true, fullName: true },
    });
    return new Map(
      members.map((m) => [
        m.id,
        (m.fullName ?? '').trim().split(/\s+/)[0] || null,
      ]),
    );
  }

  /** Each unit's code and building (ADR 0047: where an emergency is). */
  async unitLocations(
    tx: TenantTxClient,
    unitIds: readonly string[],
  ): Promise<
    Map<string, { unitId: string; unitCode: string; building: string | null }>
  > {
    const units = await tx.unit.findMany({
      where: { id: { in: [...new Set(unitIds)] } },
      select: { id: true, code: true, building: true },
    });
    return new Map(
      units.map((u) => [
        u.id,
        { unitId: u.id, unitCode: u.code, building: u.building },
      ]),
    );
  }

  /**
   * Since when each unit is in closed mode (ADR 0020), or null when it is
   * not: what a closed-unit inspection asks (ADR 0050). A plain read: the
   * gate never locks a unit's row (ADR 0044, 0045); a unit reopened while
   * its inspection is made is cancelled by the management (`unit_reopened`).
   */
  async closedSince(
    tx: TenantTxClient,
    unitIds: readonly string[],
  ): Promise<Map<string, Date | null>> {
    const units = await tx.unit.findMany({
      where: { id: { in: [...new Set(unitIds)] } },
      select: { id: true, closedSince: true },
    });
    return new Map(units.map((u) => [u.id, u.closedSince]));
  }

  /**
   * The people who live in the unit (ADR 0047): its residing occupants and
   * its active adult members with an account — the `gateEntry` holders,
   * never a landlord, a pending or removed member, a minor or an ended
   * occupancy. Each with what they are there; the primary first.
   */
  async residents(tx: TenantTxClient, unitId: string): Promise<UnitResident[]> {
    const ids = await this.capabilities.holders(tx, unitId, 'gateEntry');
    if (!ids.length) return [];
    const occupancies = await tx.unitOccupancy.findMany({
      where: { unitId, status: 'active', accountId: { in: ids } },
      select: { accountId: true, occupancyType: true, isPrimary: true },
    });
    const by = new Map(occupancies.map((o) => [o.accountId, o]));
    return ids
      .map((accountId): UnitResident => {
        const o = by.get(accountId);
        return o
          ? { accountId, role: o.occupancyType, isPrimary: o.isPrimary }
          : { accountId, role: 'member', isPrimary: false };
      })
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  }

  /** The units the account is the primary of now (ADR 0058's lists). */
  async primaryUnits(tx: TenantTxClient, accountId: string): Promise<string[]> {
    const rows = await tx.unitOccupancy.findMany({
      where: { accountId, status: 'active', isPrimary: true },
      select: { unitId: true },
    });
    return rows.map((r) => r.unitId);
  }

  /** The units where the account's capabilities carry `flag`. */
  unitsWhere(
    tx: TenantTxClient,
    accountId: string,
    flag: CapabilityFlag,
  ): Promise<string[]> {
    return this.capabilities.unitsWhere(tx, accountId, flag);
  }

  async unitCode(tx: TenantTxClient, unitId: string): Promise<string> {
    const unit = await tx.unit.findUniqueOrThrow({
      where: { id: unitId },
      select: { code: true },
    });
    return unit.code;
  }

  async unitCodes(
    tx: TenantTxClient,
    unitIds: readonly string[],
  ): Promise<Map<string, string>> {
    const units = await tx.unit.findMany({
      where: { id: { in: [...new Set(unitIds)] } },
      select: { id: true, code: true },
    });
    return new Map(units.map((u) => [u.id, u.code]));
  }

  /**
   * By the 8-digit code (its HMAC), in this compound only. A suspended
   * engagement keeps its code and codes are unique among active ones only,
   * so another engagement may carry the same code: the active one wins.
   */
  engagementByCode(
    tx: TenantTxClient,
    tenantId: string,
    code: string,
  ): Promise<GateEngagement | null> {
    return this.engagementWhere(tx, {
      accessCodeHash: this.hasher.hashWorkerCode(tenantId, code),
    });
  }

  /** By the card's QR token (its HMAC, ADR 0030), in this compound only. */
  engagementByQr(
    tx: TenantTxClient,
    tenantId: string,
    token: string,
  ): Promise<GateEngagement | null> {
    return this.engagementWhere(tx, {
      qrTokenHash: this.hasher.hashQrToken(tenantId, token),
    });
  }

  private async engagementWhere(
    tx: TenantTxClient,
    where: { accessCodeHash: string } | { qrTokenHash: string },
  ): Promise<GateEngagement | null> {
    const rows = await tx.workerEngagement.findMany({
      where,
      include: ENGAGEMENT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const e = rows.find((r) => r.status === 'active') ?? rows[0];
    return e ? toGate(e) : null;
  }

  async engagementById(
    tx: TenantTxClient,
    id: string,
  ): Promise<GateEngagement | null> {
    const e = await tx.workerEngagement.findUnique({
      where: { id },
      include: ENGAGEMENT,
    });
    return e ? toGate(e) : null;
  }

  /**
   * The compound's active engagements whose card the gate's offline bundle
   * may carry (ADR 0057): those derived with a key still in the ring, with
   * the card's token and code; and how many active ones are not (a random
   * card from before, never derivable until it is reissued).
   */
  async offlineCards(tx: TenantTxClient): Promise<{
    cards: { engagement: GateEngagement; token: string; code: string }[];
    notDerivable: number;
  }> {
    const rows = await tx.workerEngagement.findMany({
      where: { status: 'active' },
      include: ENGAGEMENT,
      orderBy: { id: 'asc' },
    });
    const cards: { engagement: GateEngagement; token: string; code: string }[] =
      [];
    for (const r of rows) {
      const secret = this.cardTokens.liveSecret(r);
      if (secret)
        cards.push({
          engagement: toGate(r),
          token: secret.token,
          code: secret.code,
        });
    }
    return { cards, notDerivable: rows.length - cards.length };
  }

  /** Serializes the gate's entries of one worker. */
  async lockEngagement(tx: TenantTxClient, id: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM worker_engagements WHERE id = ${id}::uuid FOR UPDATE`;
  }

  /** Of these engagements, the live-in ones (they live there). */
  async liveInEngagements(
    tx: TenantTxClient,
    ids: readonly string[],
  ): Promise<string[]> {
    if (!ids.length) return [];
    const rows = await tx.workerEngagement.findMany({
      where: { id: { in: [...ids] }, capacity: 'live_in' },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** An account's capabilities on a unit, or null when it has no place there. */
  placeIn(
    tx: TenantTxClient,
    accountId: string,
    unitId: string,
  ): Promise<Capabilities | null> {
    return this.capabilities.placeOf(tx, accountId, unitId);
  }

  isPrimary(
    tx: TenantTxClient,
    unitId: string,
    accountId: string,
  ): Promise<boolean> {
    return isPrimary(tx, unitId, accountId);
  }

  /**
   * Whether the caller may ask for the unit's works, moves and material
   * exits (ADR 0049, 0062): its primary, or a live `permits` delegate of
   * the primary's (`onBehalfOf` names the primary then). Null otherwise;
   * an expired delegation is DELEGATION_EXPIRED.
   */
  async permitAuthority(
    tx: TenantTxClient,
    unitId: string,
  ): Promise<{ onBehalfOf: string | null } | null> {
    const by = await this.household.find(tx, unitId, 'permits');
    return by ? { onBehalfOf: by.onBehalfOf } : null;
  }

  /** The unit's primary resident now, or null (ADR 0045: who is told). */
  async primaryOf(tx: TenantTxClient, unitId: string): Promise<string | null> {
    const row = await tx.unitOccupancy.findFirst({
      where: { unitId, status: 'active', isPrimary: true },
      select: { accountId: true },
    });
    return row?.accountId ?? null;
  }

  /**
   * The caller runs the unit's household: its primary or a `household`
   * delegate. `onBehalfOf` is the primary a delegate acts for (ADR 0016).
   */
  async requireHousehold(
    tx: TenantTxClient,
    unitId: string,
  ): Promise<{ accountId: string; onBehalfOf: string | null }> {
    return this.household.require(tx, unitId, 'household');
  }

  /** Serializes what hangs off a unit (the pass cap) for this transaction. */
  lockUnit(tx: TenantTxClient, unitId: string): Promise<void> {
    return lockUnits(tx, [unitId]);
  }

  /** A visit schedule: the worker rules for a non-live-in schedule. */
  checkSchedule(
    raw: GateSchedule | undefined,
    fields: FieldError[],
  ): GateSchedule {
    return checkSchedule('hourly', raw, fields);
  }

  isWithinSchedule(
    schedule: GateSchedule,
    instant: Date,
    timeZone: string,
  ): boolean {
    return isWithinSchedule(schedule, instant, timeZone);
  }
}

function toMinor(m: {
  id: string;
  unitId: string;
  fullName: string | null;
  birthDate: Date;
}): UnitMinor {
  // A minor's membership always carries the name (household_members CHECK).
  return {
    memberId: m.id,
    unitId: m.unitId,
    fullName: m.fullName ?? '',
    birthDate: m.birthDate,
  };
}

function toGate(e: {
  id: string;
  unitId: string;
  capacity: WorkerCapacity;
  status: WorkerEngagementStatus;
  schedule: unknown;
  validUntil: Date | null;
  suspendedByManagement: boolean;
  worker: {
    fullName: string | null;
    bannedAt: Date | null;
    photoFileId: string | null;
  };
  unit: { code: string };
}): GateEngagement {
  return {
    engagementId: e.id,
    unitId: e.unitId,
    unitCode: e.unit.code,
    workerName: e.worker.fullName ?? '',
    capacity: e.capacity,
    status: e.status,
    schedule: e.schedule as GateSchedule,
    validUntil: e.validUntil,
    banned: e.worker.bannedAt !== null,
    suspendedByManagement: e.suspendedByManagement,
    photoFileId: e.worker.photoFileId,
  };
}
