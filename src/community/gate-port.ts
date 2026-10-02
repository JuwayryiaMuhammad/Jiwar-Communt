import { Injectable } from '@nestjs/common';
import type { WorkerCapacity, WorkerEngagementStatus } from '@prisma/client';
import { IdentifierHasher } from '../core/auth/identifier';
import type { FieldError } from '../core/common/errors';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import type { Capabilities } from './capabilities/capabilities';

/** A yes/no capability (ADR 0020), e.g. visitorsInvite. */
export type CapabilityFlag = {
  [K in keyof Capabilities]: Capabilities[K] extends boolean ? K : never;
}[keyof Capabilities];
import { CapabilitiesService } from './capabilities/capabilities.service';
import {
  HouseholdAuthority,
  isPrimary,
} from './households/household-authority';
import { lockUnits } from './units/unit-lock';
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
  ) {}

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
  async holders(
    tx: TenantTxClient,
    unitId: string,
    flag: CapabilityFlag,
  ): Promise<string[]> {
    const [occupants, members] = await Promise.all([
      tx.unitOccupancy.findMany({
        where: { unitId, status: 'active' },
        select: { accountId: true },
      }),
      tx.householdMember.findMany({
        where: { unitId, status: 'active', accountId: { not: null } },
        select: { accountId: true },
      }),
    ]);
    const candidates = [
      ...new Set([
        ...occupants.map((o) => o.accountId),
        ...members.map((m) => m.accountId!),
      ]),
    ];
    const active = await tx.account.findMany({
      where: { id: { in: candidates }, status: 'active' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const out: string[] = [];
    for (const a of active) {
      const caps = await this.capabilities.placeOf(tx, a.id, unitId);
      if (caps?.[flag]) out.push(a.id);
    }
    return out;
  }

  /** The units where the account's capabilities carry `flag`. */
  async unitsWhere(
    tx: TenantTxClient,
    accountId: string,
    flag: CapabilityFlag,
  ): Promise<string[]> {
    const [occupancies, memberships] = await Promise.all([
      tx.unitOccupancy.findMany({
        where: { accountId, status: 'active' },
        select: { unitId: true },
      }),
      tx.householdMember.findMany({
        where: { accountId, status: 'active' },
        select: { unitId: true },
      }),
    ]);
    const units = [
      ...new Set([
        ...occupancies.map((o) => o.unitId),
        ...memberships.map((m) => m.unitId),
      ]),
    ];
    const out: string[] = [];
    for (const unitId of units) {
      const caps = await this.capabilities.placeOf(tx, accountId, unitId);
      if (caps?.[flag]) out.push(unitId);
    }
    return out;
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

  /** The caller runs the unit's household: its primary or a `household` delegate. */
  async requireHousehold(tx: TenantTxClient, unitId: string): Promise<void> {
    await this.household.require(tx, unitId, 'household');
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
