import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  $Enums,
  Prisma,
  type WorkerCapacity,
  type WorkerEngagement,
  type WorkerEngagementStatus,
} from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { IdentifierHasher, normalizePhone } from '../../core/auth/identifier';
import type { AppClsStore } from '../../core/common/cls/app-cls';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  ADULT_AGE,
  isAdult,
  parseEgyptianNationalId,
} from '../../core/common/egyptian-national-id';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { requireReason } from '../households/households.service';
import { lockUnits } from '../units/unit-lock';
import {
  checkSchedule,
  schedulesOverlap,
  type WorkerSchedule,
} from './schedule';
import { WorkersAuthority } from './workers-authority';

export interface NewWorker {
  fullName: string;
  nationalId: string;
  phone: string;
  capacity: WorkerCapacity;
  schedule?: WorkerSchedule;
  /** Required for `temporary`. */
  validUntil?: Date;
}

export interface Registered {
  engagementId: string;
  status: WorkerEngagementStatus;
  /** Never says which unit, how many, or anything else about the other engagement. */
  warnings: { code: typeof ErrorCode.WORKER_SCHEDULE_CONFLICT }[];
}

/** An access code, shown once; only its HMAC is stored. */
export interface IssuedCode {
  engagementId: string;
  accessCode: string;
}

/** What residents see: their own units' engagements, nothing else. */
export interface EngagementView {
  id: string;
  unitId: string;
  workerName: string;
  capacity: WorkerCapacity;
  schedule: WorkerSchedule;
  status: WorkerEngagementStatus;
  validUntil: Date | null;
  suspendedByManagement: boolean;
}

type NoticeKey =
  | 'engagement_suspended'
  | 'engagement_suspended_by_management'
  | 'engagement_resumed'
  | 'engagement_ended';

const OPEN: WorkerEngagementStatus[] = [
  'pending_review',
  'active',
  'suspended',
];
const CODE_ATTEMPTS = 10;

/**
 * Domestic workers (ADR 0017). Workers have no account and no login; the
 * compound knows each person once (by national-ID HMAC) and each unit they
 * serve is an engagement, reviewed by management.
 *
 * - An access code is 8 digits, returned once, stored as an HMAC, and valid
 *   only while its engagement is `active` — it has no expiry of its own.
 *   Suspension (and a ban) keeps it but it stops working; resume brings the
 *   same code back. End, temporary expiry, reissue and rejection destroy it.
 * - Every suspension, resumption and end writes a worker notice in the same
 *   transaction: it is never silent.
 * - A temporary engagement past `valid_until` reads as ended; the first
 *   write that touches it persists that (actor `system`).
 * - Residents see only their own units' engagements, and never a national
 *   ID, another unit, a count, or a ban reason.
 */
@Injectable()
export class WorkersService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly cls: ClsService<AppClsStore>,
    private readonly authority: WorkersAuthority,
    private readonly hasher: IdentifierHasher,
    private readonly audit: AuditService,
  ) {}

  // --------------------------------------------------------------------------
  // Residents
  // --------------------------------------------------------------------------

  async register(unitId: string, input: NewWorker): Promise<Registered> {
    const valid = validateWorker(input);
    const tenantId = this.ctx.tenantId;
    const nationalIdHash = this.hasher.hashWorkerNationalId(valid.nationalId);
    return this.tenantTx.withTenantTx(async (tx) => {
      await lockUnits(tx, [unitId]);
      const by = await this.authority.forRegister(tx, unitId);

      // One record per person per compound. An existing record is reused
      // as it is; nothing about it is returned.
      await tx.domesticWorker.createMany({
        data: [
          {
            id: newId(),
            tenantId,
            nationalIdHash,
            nationalId: valid.nationalId,
            fullName: valid.fullName,
            phone: valid.phone,
            birthDate: valid.birthDate,
          },
        ],
        skipDuplicates: true,
      });
      const worker = await tx.domesticWorker.findUniqueOrThrow({
        where: { tenantId_nationalIdHash: { tenantId, nationalIdHash } },
        select: { id: true, bannedAt: true },
      });
      if (worker.bannedAt) throw blocked();

      const others = await tx.workerEngagement.findMany({
        where: {
          workerId: worker.id,
          unitId: { not: unitId },
          status: 'active',
        },
        select: { schedule: true, validUntil: true },
      });
      const conflict = others.some(
        (o) =>
          !isPast(o.validUntil) &&
          schedulesOverlap(
            valid.schedule,
            o.schedule as unknown as WorkerSchedule,
          ),
      );

      const engagement = await tx.workerEngagement.create({
        data: {
          id: newId(),
          tenantId,
          workerId: worker.id,
          unitId,
          requestedById: by.accountId,
          capacity: valid.capacity,
          schedule: valid.schedule as unknown as Prisma.InputJsonValue,
          validUntil: valid.validUntil,
        },
      });
      await this.audit.record(tx, {
        action: 'worker.registered',
        targetId: engagement.id,
        changes: diffChanges(
          null,
          {
            unitId,
            capacity: engagement.capacity,
            schedule: valid.schedule,
            validUntil: engagement.validUntil,
            status: engagement.status,
          },
          'worker.registered',
        ),
        metadata: {
          workerId: worker.id,
          scheduleConflict: conflict,
          ...onBehalfOf(by.onBehalfOf),
        },
      });
      return {
        engagementId: engagement.id,
        status: engagement.status,
        warnings: conflict
          ? [{ code: ErrorCode.WORKER_SCHEDULE_CONFLICT }]
          : [],
      };
    });
  }

  /** The unit's engagements, as a resident (or family member) of it sees them. */
  async listForUnit(unitId: string): Promise<EngagementView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.authority.assertVisible(tx, unitId);
      const rows = await tx.workerEngagement.findMany({
        where: { unitId, status: { not: 'rejected' } },
        include: { worker: { select: { fullName: true } } },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map((e) => ({
        id: e.id,
        unitId: e.unitId,
        workerName: e.worker.fullName,
        capacity: e.capacity,
        schedule: e.schedule as unknown as WorkerSchedule,
        status: effectiveStatus(e),
        validUntil: e.validUntil,
        suspendedByManagement: e.suspendedByManagement,
      }));
    });
  }

  async suspend(engagementId: string, reason: string): Promise<void> {
    const why = requireReason(reason);
    await this.change(engagementId, async (tx, e, actingFor) => {
      if (e.status !== 'active') throw engagementNotFound();
      await tx.workerEngagement.update({
        where: { id: e.id },
        data: { status: 'suspended', statusReason: why },
      });
      await this.notice(tx, e, 'engagement_suspended', { reason: why });
      await this.record(
        tx,
        e,
        'worker.engagement_suspended',
        'suspended',
        actingFor,
      );
      return undefined;
    });
  }

  /**
   * Brings back the SAME code. Only if another active engagement took that
   * code meanwhile (unique among active ones) is a new one issued — and then
   * returned, once.
   */
  async resume(engagementId: string): Promise<IssuedCode | null> {
    return this.change(engagementId, async (tx, e, actingFor) => {
      if (e.status !== 'suspended') throw engagementNotFound();
      if (e.suspendedByManagement) {
        const worker = await tx.domesticWorker.findUniqueOrThrow({
          where: { id: e.workerId },
          select: { bannedAt: true },
        });
        if (worker.bannedAt) throw blocked();
      }
      const taken = e.accessCodeHash
        ? await tx.workerEngagement.count({
            where: {
              accessCodeHash: e.accessCodeHash,
              status: 'active',
              id: { not: e.id },
            },
          })
        : 1;
      const replacement = taken ? await this.newCode(tx, e.tenantId) : null;
      await tx.workerEngagement.update({
        where: { id: e.id },
        data: {
          status: 'active',
          statusReason: null,
          suspendedByManagement: false,
          ...(replacement
            ? { accessCodeHash: replacement.hash, codeIssuedAt: new Date() }
            : {}),
        },
      });
      await this.notice(tx, e, 'engagement_resumed', {});
      await this.record(
        tx,
        e,
        'worker.engagement_resumed',
        'active',
        actingFor,
        {
          codeReplaced: replacement !== null,
        },
      );
      return replacement
        ? { engagementId: e.id, accessCode: replacement.code }
        : null;
    });
  }

  async end(engagementId: string, reason: string): Promise<void> {
    const why = requireReason(reason);
    await this.change(engagementId, async (tx, e, actingFor) => {
      if (!OPEN.includes(e.status)) throw engagementNotFound();
      await this.close(tx, e, why);
      await this.record(tx, e, 'worker.engagement_ended', 'ended', actingFor);
      return undefined;
    });
  }

  /** A lost or confiscated card: a new code, the old one dead at once. */
  async reissueCode(engagementId: string): Promise<IssuedCode> {
    return this.change(engagementId, async (tx, e, actingFor) => {
      if (e.status !== 'active' && e.status !== 'suspended')
        throw engagementNotFound();
      const code = await this.newCode(tx, e.tenantId);
      await tx.workerEngagement.update({
        where: { id: e.id },
        data: { accessCodeHash: code.hash, codeIssuedAt: new Date() },
      });
      await this.audit.record(tx, {
        action: 'worker.code_reissued',
        targetId: e.id,
        metadata: {
          unitId: e.unitId,
          workerId: e.workerId,
          ...onBehalfOf(actingFor),
        },
      });
      return { engagementId: e.id, accessCode: code.code };
    });
  }

  /**
   * The only code check (the gate uses it later): valid while its
   * engagement is active and, for temporary work, not past its end.
   */
  async isCodeValid(code: string): Promise<boolean> {
    if (!/^\d{8}$/.test(code)) return false;
    const hash = this.hasher.hashWorkerCode(this.ctx.tenantId, code);
    return this.tenantTx.withTenantTx(async (tx) => {
      const e = await tx.workerEngagement.findFirst({
        where: { accessCodeHash: hash, status: 'active' },
        select: { validUntil: true },
      });
      return e !== null && !isPast(e.validUntil);
    });
  }

  // --------------------------------------------------------------------------
  // Management
  // --------------------------------------------------------------------------

  /** `workers.review`. Approve returns the access code, once. */
  async review(
    engagementId: string,
    decision: 'approve' | 'reject',
    reason?: string,
  ): Promise<IssuedCode | null> {
    const why = decision === 'reject' ? requireReason(reason) : null;
    return this.change(engagementId, async (tx, e) => {
      if (e.status !== 'pending_review') throw engagementNotFound();
      const reviewedById = this.ctx.accountId;
      if (decision === 'reject') {
        await tx.workerEngagement.update({
          where: { id: e.id },
          data: { status: 'rejected', statusReason: why, reviewedById },
        });
        await this.record(
          tx,
          e,
          'worker.engagement_reviewed',
          'rejected',
          null,
          {
            decision,
          },
        );
        return null;
      }
      const worker = await tx.domesticWorker.findUniqueOrThrow({
        where: { id: e.workerId },
        select: { bannedAt: true },
      });
      if (worker.bannedAt) throw blocked();
      const code = await this.newCode(tx, e.tenantId);
      await tx.workerEngagement.update({
        where: { id: e.id },
        data: {
          status: 'active',
          accessCodeHash: code.hash,
          codeIssuedAt: new Date(),
          reviewedById,
        },
      });
      await this.record(tx, e, 'worker.engagement_reviewed', 'active', null, {
        decision,
      });
      return { engagementId: e.id, accessCode: code.code };
    });
  }

  /**
   * `workers.ban`, manager only. Every active engagement is suspended by
   * management (codes kept, not working), with a notice each. Residents see
   * `suspendedByManagement`, never the reason.
   */
  async ban(workerId: string, reason: string): Promise<void> {
    const why = requireReason(reason);
    await this.tenantTx.withTenantTx(async (tx) => {
      const worker = await tx.domesticWorker.findFirst({
        where: { id: workerId, bannedAt: null },
      });
      if (!worker) throw workerNotFound();
      await tx.domesticWorker.update({
        where: { id: workerId },
        data: {
          bannedAt: new Date(),
          bannedById: this.ctx.accountId,
          banReason: why,
        },
      });
      const active = await tx.workerEngagement.findMany({
        where: { workerId, status: 'active' },
      });
      for (const e of active) {
        if (await this.expireIfDue(tx, e)) continue;
        await tx.workerEngagement.update({
          where: { id: e.id },
          data: { status: 'suspended', suspendedByManagement: true },
        });
        await this.notice(tx, e, 'engagement_suspended_by_management', {
          reason: why,
        });
      }
      await this.audit.record(tx, {
        action: 'worker.banned',
        targetId: workerId,
        changes: diffChanges(
          { banned: false },
          { banned: true },
          'worker.banned',
        ),
        // The reason stays on the worker record: free text may name people.
        metadata: { engagementsSuspended: active.map((e) => e.id) },
      });
    });
  }

  /** Lifts the ban only; suspended engagements wait for a resume. */
  async unban(workerId: string): Promise<void> {
    await this.tenantTx.withTenantTx(async (tx) => {
      const { count } = await tx.domesticWorker.updateMany({
        where: { id: workerId, bannedAt: { not: null } },
        data: { bannedAt: null, bannedById: null, banReason: null },
      });
      if (count === 0) throw workerNotFound();
      await this.audit.record(tx, {
        action: 'worker.unbanned',
        targetId: workerId,
        changes: diffChanges(
          { banned: true },
          { banned: false },
          'worker.unbanned',
        ),
      });
    });
  }

  // --------------------------------------------------------------------------

  /**
   * Loads the engagement, checks who may act on it, and settles a temporary
   * expiry first: an expired engagement is persisted as ended (that write
   * commits) and the requested change is refused as not found.
   */
  private async change<T>(
    engagementId: string,
    fn: (
      tx: TenantTxClient,
      e: WorkerEngagement,
      onBehalfOf: string | null,
    ) => Promise<T>,
  ): Promise<T> {
    const result = await this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.workerEngagement.findUnique({
        where: { id: engagementId },
      });
      if (!found) throw engagementNotFound();
      await lockUnits(tx, [found.unitId]);
      const e = await tx.workerEngagement.findUniqueOrThrow({
        where: { id: engagementId },
      });
      const by = await this.authority.forEngagement(tx, e);
      if (await this.expireIfDue(tx, e)) return { expired: true as const };
      return { expired: false as const, value: await fn(tx, e, by.onBehalfOf) };
    });
    if (result.expired) throw engagementNotFound();
    return result.value;
  }

  /** Temporary work past its end: ended, code destroyed, notice, audit as system. */
  private async expireIfDue(
    tx: TenantTxClient,
    e: WorkerEngagement,
  ): Promise<boolean> {
    if (!OPEN.includes(e.status) || !isPast(e.validUntil)) return false;
    await this.close(tx, e, 'expired');
    await this.cls.run({ ifNested: 'inherit' }, async () => {
      this.cls.set('auditActor', { type: 'system', id: null });
      await this.record(tx, e, 'worker.engagement_ended', 'ended', null, {
        reason: 'expired',
      });
    });
    return true;
  }

  private async close(tx: TenantTxClient, e: WorkerEngagement, reason: string) {
    await tx.workerEngagement.update({
      where: { id: e.id },
      data: {
        status: 'ended',
        statusReason: reason,
        accessCodeHash: null,
        suspendedByManagement: false,
      },
    });
    await this.notice(tx, e, 'engagement_ended', { reason });
  }

  private async notice(
    tx: TenantTxClient,
    e: WorkerEngagement,
    noticeKey: NoticeKey,
    params: Record<string, string>,
  ) {
    await tx.workerNotice.create({
      data: {
        id: newId(),
        tenantId: e.tenantId,
        workerId: e.workerId,
        engagementId: e.id,
        noticeKey,
        params,
      },
    });
  }

  private record(
    tx: TenantTxClient,
    e: WorkerEngagement,
    action:
      | 'worker.engagement_reviewed'
      | 'worker.engagement_suspended'
      | 'worker.engagement_resumed'
      | 'worker.engagement_ended',
    status: WorkerEngagementStatus,
    actingFor: string | null,
    metadata: Record<string, unknown> = {},
  ) {
    return this.audit.record(tx, {
      action,
      targetId: e.id,
      changes: diffChanges({ status: e.status }, { status }, action),
      // Reasons stay on the engagement and in the worker's notice.
      metadata: {
        unitId: e.unitId,
        workerId: e.workerId,
        ...metadata,
        ...onBehalfOf(actingFor),
      },
    });
  }

  /** 8 digits, unique among the compound's active engagements. */
  private async newCode(tx: TenantTxClient, tenantId: string) {
    for (let i = 0; i < CODE_ATTEMPTS; i++) {
      const code = randomInt(0, 100_000_000).toString().padStart(8, '0');
      const hash = this.hasher.hashWorkerCode(tenantId, code);
      const taken = await tx.workerEngagement.count({
        where: { accessCodeHash: hash, status: 'active' },
      });
      if (!taken) return { code, hash };
    }
    // 10 collisions in a row among 10^8 codes means something is wrong.
    throw new Error('Could not find a free access code');
  }
}

// ----------------------------------------------------------------------------

function effectiveStatus(e: {
  status: WorkerEngagementStatus;
  validUntil: Date | null;
}): WorkerEngagementStatus {
  return OPEN.includes(e.status) && isPast(e.validUntil) ? 'ended' : e.status;
}

function isPast(date: Date | null): boolean {
  return date !== null && date <= new Date();
}

function onBehalfOf(primary: string | null): Record<string, unknown> {
  return primary ? { onBehalfOf: primary } : {};
}

function validateWorker(input: NewWorker) {
  const fields: FieldError[] = [];
  const fullName = (input.fullName ?? '').trim();
  if (fullName.length < 2 || fullName.length > 200) {
    fields.push({
      field: 'fullName',
      code: FieldErrorCode.INVALID_LENGTH,
      params: { min: 2, max: 200 },
    });
  }
  const phone = input.phone ? normalizePhone(input.phone) : null;
  if (!phone)
    fields.push({ field: 'phone', code: FieldErrorCode.INVALID_PHONE });
  const nationalId = parseEgyptianNationalId(input.nationalId ?? '');
  if (!nationalId)
    fields.push({
      field: 'nationalId',
      code: FieldErrorCode.INVALID_NATIONAL_ID,
    });
  const capacities = Object.values($Enums.WorkerCapacity);
  if (!capacities.includes(input.capacity)) {
    fields.push({
      field: 'capacity',
      code: FieldErrorCode.INVALID_VALUE,
      params: { allowed: capacities },
    });
  }
  const schedule = checkSchedule(input.capacity, input.schedule, fields);
  const validUntil = input.validUntil ?? null;
  if (
    (input.capacity === 'temporary' && !validUntil) ||
    (validUntil &&
      (!(validUntil instanceof Date) ||
        Number.isNaN(validUntil.getTime()) ||
        validUntil <= new Date()))
  ) {
    fields.push({ field: 'validUntil', code: FieldErrorCode.INVALID_VALUE });
  }
  if (fields.length || !nationalId || !phone) {
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid worker', {
      fields,
    });
  }
  // No override of any kind: not by a manager, not by a flag.
  if (!isAdult(nationalId.birthDate)) {
    throw appError.badRequest(
      ErrorCode.WORKER_UNDERAGE,
      'Domestic workers must be adults',
      { params: { minAge: ADULT_AGE } },
    );
  }
  return {
    fullName,
    phone,
    nationalId: nationalId.value,
    birthDate: nationalId.birthDate,
    capacity: input.capacity,
    schedule,
    validUntil,
  };
}

function blocked() {
  return appError.forbidden(
    ErrorCode.WORKER_BLOCKED_BY_MANAGEMENT,
    'This worker is blocked by the compound management',
  );
}

function engagementNotFound() {
  return appError.notFound(
    ErrorCode.ENGAGEMENT_NOT_FOUND,
    'Engagement not found',
  );
}

function workerNotFound() {
  return appError.notFound(ErrorCode.WORKER_NOT_FOUND, 'Worker not found');
}
