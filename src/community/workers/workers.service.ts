import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  $Enums,
  Prisma,
  type DomesticWorker,
  type WorkerCapacity,
  type WorkerEngagement,
  type WorkerEngagementStatus,
  type WageObligationKind,
} from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { IdentifierHasher, normalizePhone } from '../../core/auth/identifier';
import type { AppClsStore } from '../../core/common/cls/app-cls';
import { RequestContext } from '../../core/common/cls/request-context';
import { ADULT_AGE, isAdult } from '../../core/common/egyptian-national-id';
import {
  checkBirthDate,
  checkIdentityDocument,
  invalidDocument,
  type IdentityDocumentInput,
} from '../../core/common/identity-document';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import {
  REASON_CODES,
  requireReasonCode,
  type ReasonInput,
} from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { requireReason } from '../households/households.service';
import { COMMUNITY_NOTICES } from '../notices/community-notices';
import { CommunityNotifier } from '../notices/community-notifier';
import { lockUnits } from '../units/unit-lock';
import {
  checkSchedule,
  schedulesOverlap,
  type WorkerSchedule,
} from './schedule';
import { WorkersAuthority } from './workers-authority';

/** National ID or passport (ADR 0018). */
export interface NewWorker extends IdentityDocumentInput {
  fullName: string;
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

export interface ReviewOptions {
  /** Required to reject. */
  reason?: string;
  /**
   * Passport workers only: the manager attests the birth date, once per
   * worker (ADR 0018). `birthDate` corrects it at the same time.
   */
  birthDateConfirmed?: boolean;
  birthDate?: Date | string;
}

/** An access code, shown once; only its HMAC is stored. */
export interface IssuedCode {
  engagementId: string;
  accessCode: string;
}

export interface CardIncidentView {
  id: string;
  engagementId: string;
  workerId: string;
  type: 'lost' | 'confiscated';
  reportedVia: 'manager' | 'resident';
  reportedAt: Date;
  note: string | null;
  status: 'open' | 'closed';
}

export interface ComplianceCaseView {
  id: string;
  workerId: string;
  kind: 'underage';
  status: 'open' | 'closed';
  source: 'review' | 'birth_date_correction' | 'report';
  openedAt: Date;
  closedAt: Date | null;
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
  | 'code_reissued'
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
    private readonly notifier: CommunityNotifier,
    private readonly staff: StaffRecipients,
  ) {}

  // --------------------------------------------------------------------------
  // Residents
  // --------------------------------------------------------------------------

  async register(unitId: string, input: NewWorker): Promise<Registered> {
    const valid = validateWorker(input);
    const tenantId = this.ctx.tenantId;
    const idDocumentHash =
      valid.document.idDocumentType === 'passport'
        ? this.hasher.hashWorkerPassport(
            valid.document.nationality,
            valid.document.idDocumentNumber,
          )
        : this.hasher.hashWorkerNationalId(valid.document.idDocumentNumber);
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
            idDocumentHash,
            ...valid.document,
            fullName: valid.fullName,
            phone: valid.phone,
          },
        ],
        skipDuplicates: true,
      });
      const worker = await tx.domesticWorker.findUniqueOrThrow({
        where: {
          tenantId_idDocumentHash: { tenantId, idDocumentHash },
        },
        select: { id: true, bannedAt: true, birthDate: true },
      });
      if (worker.bannedAt) throw blocked();
      // The stored (possibly corrected) date counts too, not only the
      // entered one: no way around the age rule by re-registering.
      if (!isAdult(worker.birthDate)) throw underage();

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
      const worker = await tx.domesticWorker.findUniqueOrThrow({
        where: { id: e.workerId },
        select: { bannedAt: true, birthDate: true },
      });
      if (worker.bannedAt) throw blocked();
      if (!isAdult(worker.birthDate)) throw underage();
      // A report can say "under 18" while the document says adult: the
      // case holds every resume until compliance closes it.
      if (await this.underCompliance(tx, e.workerId)) throw complianceHold();
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

  /**
   * A new code, the old one dead in the same transaction (the gate checks
   * the stored hash). By whoever may act on the engagement, with a reason
   * code: `lost` also files a lost-card incident. A resident can never
   * file a confiscation — management does (reportCardIncident).
   */
  async reissueCode(
    engagementId: string,
    reasonCode: string,
  ): Promise<IssuedCode> {
    const code = requireReasonCode(
      { code: reasonCode, text: reasonCode },
      REASON_CODES.cardReissue,
    ).code;
    return this.change(engagementId, async (tx, e, actingFor) => {
      if (e.status !== 'active' && e.status !== 'suspended')
        throw engagementNotFound();
      const incidentId =
        code === 'lost' ? await this.fileIncident(tx, e, 'lost', null) : null;
      const issued = await this.replaceCode(tx, e, {
        reasonCode: code,
        incidentId,
        actingFor,
      });
      return issued;
    });
  }

  /**
   * Management files a lost or confiscated card for the worker
   * (`workers.incidents`; the worker's page and the gate come later). The
   * replacement is free and immediate. A confiscation goes to management
   * and security — never to the resident, who may be the one who took it;
   * the resident only learns that the code was reissued.
   */
  async reportCardIncident(
    engagementId: string,
    type: 'lost' | 'confiscated',
    note?: string,
  ): Promise<IssuedCode & { incidentId: string }> {
    if (type !== 'lost' && type !== 'confiscated') {
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid type', {
        fields: [
          {
            field: 'type',
            code: FieldErrorCode.INVALID_VALUE,
            params: { allowed: ['lost', 'confiscated'] },
          },
        ],
      });
    }
    return this.change(engagementId, async (tx, e) => {
      if (e.status !== 'active' && e.status !== 'suspended')
        throw engagementNotFound();
      const incidentId = await this.fileIncident(
        tx,
        e,
        type,
        note?.trim() || null,
      );
      const issued = await this.replaceCode(tx, e, {
        reasonCode: type,
        incidentId,
        actingFor: null,
      });
      if (type === 'confiscated') {
        const holders = await this.staff.holding(tx, 'workers.incidents');
        const place = await this.notifier.place(tx, e.tenantId, e.unitId);
        if (holders.length) {
          await this.notifier.toAccounts(
            tx,
            e.tenantId,
            holders.map((r) => r.id),
            COMMUNITY_NOTICES.cardConfiscated,
            { ...place, incidentId },
          );
        } else {
          await this.notifier.undeliverable(
            tx,
            e.tenantId,
            COMMUNITY_NOTICES.cardConfiscated,
          );
        }
      }
      return { ...issued, incidentId };
    });
  }

  /** `workers.incidents`: the file is closed. */
  async closeCardIncident(incidentId: string): Promise<void> {
    await this.tenantTx.withTenantTx(async (tx) => {
      const { count } = await tx.workerCardIncident.updateMany({
        where: { id: incidentId, status: 'open' },
        data: {
          status: 'closed',
          closedAt: new Date(),
          closedById: this.ctx.accountId,
        },
      });
      if (count === 0) throw incidentNotFound();
      const incident = await tx.workerCardIncident.findUniqueOrThrow({
        where: { id: incidentId },
      });
      await this.audit.record(tx, {
        action: 'worker.card_incident_closed',
        targetId: incident.engagementId,
        changes: diffChanges(
          { status: 'open' },
          { status: 'closed' },
          'worker.card_incident_closed',
        ),
        metadata: { incidentId, type: incident.type },
      });
    });
  }

  /** `workers.incidents`: newest first. Residents have no read of these. */
  async cardIncidents(
    q: { status?: 'open' | 'closed' } = {},
  ): Promise<CardIncidentView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.workerCardIncident.findMany({
        where: q.status ? { status: q.status } : {},
        orderBy: [{ reportedAt: 'desc' }, { id: 'desc' }],
        take: 100,
      });
      return rows.map((r) => ({
        id: r.id,
        engagementId: r.engagementId,
        workerId: r.workerId,
        type: r.type,
        reportedVia: r.reportedVia,
        reportedAt: r.reportedAt,
        note: r.note,
        status: r.status,
      }));
    });
  }

  private async fileIncident(
    tx: TenantTxClient,
    e: WorkerEngagement,
    type: 'lost' | 'confiscated',
    note: string | null,
  ): Promise<string> {
    const id = newId();
    const reportedVia =
      this.ctx.accountType === 'manager' ? 'manager' : 'resident';
    await tx.workerCardIncident.create({
      data: {
        id,
        tenantId: e.tenantId,
        engagementId: e.id,
        workerId: e.workerId,
        type,
        reportedVia,
        reportedById: this.ctx.accountId,
        note,
      },
    });
    await this.audit.record(tx, {
      action: 'worker.card_incident_reported',
      targetId: e.id,
      metadata: { incidentId: id, type, reportedVia, workerId: e.workerId },
    });
    return id;
  }

  /**
   * The new code replaces the old hash in this transaction: the old code is
   * dead at commit. The worker gets a notice; the requester and the primary
   * learn only that the code was reissued (no type, no note).
   */
  private async replaceCode(
    tx: TenantTxClient,
    e: WorkerEngagement,
    how: {
      reasonCode: string;
      incidentId: string | null;
      actingFor: string | null;
    },
  ): Promise<IssuedCode> {
    const code = await this.newCode(tx, e.tenantId);
    await tx.workerEngagement.update({
      where: { id: e.id },
      data: { accessCodeHash: code.hash, codeIssuedAt: new Date() },
    });
    await this.notice(tx, e, 'code_reissued', {});
    await this.audit.record(tx, {
      action: 'worker.code_reissued',
      targetId: e.id,
      metadata: {
        unitId: e.unitId,
        workerId: e.workerId,
        reasonCode: how.reasonCode,
        ...(how.incidentId ? { incidentId: how.incidentId } : {}),
        ...onBehalfOf(how.actingFor),
      },
    });
    const primary = await tx.unitOccupancy.findFirst({
      where: { unitId: e.unitId, status: 'active', isPrimary: true },
      select: { accountId: true },
    });
    const residents = [e.requestedById, primary?.accountId].filter(
      (id): id is string => !!id && id !== this.ctx.accountId,
    );
    if (residents.length) {
      const worker = await tx.domesticWorker.findUniqueOrThrow({
        where: { id: e.workerId },
        select: { fullName: true },
      });
      await this.notifier.toAccounts(
        tx,
        e.tenantId,
        residents,
        COMMUNITY_NOTICES.workerCodeReissued,
        {
          ...(await this.notifier.place(tx, e.tenantId, e.unitId)),
          workerName: worker.fullName,
        },
      );
    }
    return { engagementId: e.id, accessCode: code.code };
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

  /**
   * `workers.review`. Approve returns the access code, once.
   *
   * A passport worker's birth date must be attested by the manager before
   * the first approval (`birthDateConfirmed`), optionally correcting it.
   * If the worker turns out to be under 18, this engagement is rejected and
   * every other active one is suspended by management — those changes
   * commit — and the call fails with WORKER_UNDERAGE. No override.
   */
  async review(
    engagementId: string,
    decision: 'approve' | 'reject',
    options: ReviewOptions = {},
  ): Promise<IssuedCode | null> {
    const why = decision === 'reject' ? requireReason(options.reason) : null;
    const corrected =
      options.birthDate === undefined
        ? null
        : validBirthDate(options.birthDate);
    const outcome = await this.change(engagementId, async (tx, e) => {
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
      });
      if (worker.bannedAt) throw blocked();

      let birthDate = worker.birthDate;
      if (
        worker.idDocumentType === 'passport' &&
        (!worker.birthDateVerifiedAt || corrected)
      ) {
        if (options.birthDateConfirmed !== true) {
          throw appError.badRequest(
            ErrorCode.BIRTH_DATE_CONFIRMATION_REQUIRED,
            "Confirm the worker's birth date against the passport",
          );
        }
        birthDate = corrected ?? worker.birthDate;
        await this.attest(tx, worker, birthDate, e.id);
      }

      if (!isAdult(birthDate)) {
        await tx.workerEngagement.update({
          where: { id: e.id },
          data: { status: 'rejected', statusReason: 'underage', reviewedById },
        });
        await this.record(
          tx,
          e,
          'worker.engagement_reviewed',
          'rejected',
          null,
          {
            decision,
            reason: 'underage',
          },
        );
        await this.suspendAllUnderage(tx, worker.id, 'review');
        return { underage: true as const };
      }

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
    if (outcome && 'underage' in outcome) throw underage();
    return outcome;
  }

  /**
   * `workers.review`: corrects a passport worker's birth date outside a
   * review. The attestation is cleared (the next approval needs a new one);
   * if the worker is now under 18, every active engagement is suspended by
   * management, each with a notice.
   */
  async correctBirthDate(workerId: string, birthDate: Date | string) {
    const date = validBirthDate(birthDate);
    await this.tenantTx.withTenantTx(async (tx) => {
      const worker = await tx.domesticWorker.findUnique({
        where: { id: workerId },
      });
      if (!worker) throw workerNotFound();
      if (worker.idDocumentType !== 'passport') {
        // A national ID carries the birth date; it cannot be corrected.
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'The birth date comes from the national ID',
          {
            fields: [
              { field: 'birthDate', code: FieldErrorCode.FIELD_NOT_ALLOWED },
            ],
          },
        );
      }
      await tx.domesticWorker.update({
        where: { id: workerId },
        data: {
          birthDate: date,
          birthDateVerifiedAt: null,
          birthDateVerifiedById: null,
        },
      });
      await this.audit.record(tx, {
        action: 'worker.birth_date_corrected',
        targetId: workerId,
        changes: diffChanges(
          {
            birthDate: worker.birthDate,
            birthDateVerified: worker.birthDateVerifiedAt !== null,
          },
          { birthDate: date, birthDateVerified: false },
          'worker.birth_date_corrected',
        ),
      });
      if (!isAdult(date)) {
        await this.suspendAllUnderage(tx, workerId, 'birth_date_correction');
      }
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

  /** Records the manager's attestation (and correction) of a passport birth date. */
  private async attest(
    tx: TenantTxClient,
    worker: DomesticWorker,
    birthDate: Date,
    engagementId: string,
  ) {
    await tx.domesticWorker.update({
      where: { id: worker.id },
      data: {
        birthDate,
        birthDateVerifiedAt: new Date(),
        birthDateVerifiedById: this.ctx.accountId,
      },
    });
    await this.audit.record(tx, {
      action: 'worker.birth_date_attested',
      targetId: worker.id,
      changes: diffChanges(
        { birthDate: worker.birthDate, birthDateVerified: false },
        { birthDate, birthDateVerified: true },
        'worker.birth_date_attested',
      ),
      metadata: {
        engagementId,
        corrected: birthDate.getTime() !== worker.birthDate.getTime(),
      },
    });
  }

  /**
   * The worker is under 18: every active engagement is suspended by
   * management, with a notice and an audit entry each (reason `underage`);
   * a compliance case is opened (or kept) and its holders are told; and
   * every engagement that ever had a code owes the wage in full (11 §7:
   * depriving the worker would punish the one who did nothing wrong).
   */
  private async suspendAllUnderage(
    tx: TenantTxClient,
    workerId: string,
    source: 'review' | 'birth_date_correction' | 'report',
    report?: { code: string; text: string },
  ) {
    const active = await tx.workerEngagement.findMany({
      where: { workerId, status: 'active' },
    });
    for (const e of active) {
      if (await this.expireIfDue(tx, e)) continue;
      await tx.workerEngagement.update({
        where: { id: e.id },
        data: {
          status: 'suspended',
          suspendedByManagement: true,
          statusReason: 'underage',
        },
      });
      await this.notice(tx, e, 'engagement_suspended_by_management', {
        reason: 'underage',
      });
      await this.record(
        tx,
        e,
        'worker.engagement_suspended',
        'suspended',
        null,
        { reason: 'underage' },
      );
    }
    await this.openUnderageCase(tx, workerId, source, report);
    const worked = await tx.workerEngagement.findMany({
      where: { workerId, codeIssuedAt: { not: null } },
    });
    for (const e of worked) await this.recordObligation(tx, e, 'pay_in_full');
  }

  // --------------------------------------------------------------------------
  // Compliance (ADR 0022)
  // --------------------------------------------------------------------------

  /**
   * `workers.compliance`: a report (a review, a tip) that a worker is under
   * 18, even when their document says otherwise. Every active code stops at
   * once, a case opens, and the wage is owed in full.
   */
  async reportUnderage(
    workerId: string,
    reasonInput: ReasonInput,
  ): Promise<string> {
    const reason = requireReasonCode(
      reasonInput,
      REASON_CODES.complianceReport,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const worker = await tx.domesticWorker.findUnique({
        where: { id: workerId },
        select: { id: true },
      });
      if (!worker) throw workerNotFound();
      await this.suspendAllUnderage(tx, workerId, 'report', reason);
      const open = await tx.workerComplianceCase.findFirstOrThrow({
        where: { workerId, kind: 'underage', status: 'open' },
        select: { id: true },
      });
      return open.id;
    });
  }

  /** `workers.compliance`: closes a case, with a reason. It stays on record. */
  async closeComplianceCase(
    caseId: string,
    reasonInput: ReasonInput,
  ): Promise<void> {
    const reason = requireReasonCode(reasonInput, REASON_CODES.complianceClose);
    await this.tenantTx.withTenantTx(async (tx) => {
      const { count } = await tx.workerComplianceCase.updateMany({
        where: { id: caseId, status: 'open' },
        data: {
          status: 'closed',
          closedAt: new Date(),
          closedById: this.ctx.accountId,
          closeReasonCode: reason.code,
          closeNote: reason.text,
        },
      });
      if (count === 0) throw caseNotFound();
      const c = await tx.workerComplianceCase.findUniqueOrThrow({
        where: { id: caseId },
      });
      await this.audit.record(tx, {
        action: 'worker.compliance_case_closed',
        targetId: c.workerId,
        changes: diffChanges(
          { status: 'open' },
          { status: 'closed' },
          'worker.compliance_case_closed',
        ),
        metadata: { caseId, kind: c.kind, reasonCode: reason.code },
      });
    });
  }

  /** `workers.compliance`: the compliance record, newest first. */
  async complianceCases(
    q: { status?: 'open' | 'closed' } = {},
  ): Promise<ComplianceCaseView[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.workerComplianceCase.findMany({
        where: q.status ? { status: q.status } : {},
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        take: 100,
      });
      return rows.map((r) => ({
        id: r.id,
        workerId: r.workerId,
        kind: r.kind,
        status: r.status,
        source: r.source,
        openedAt: r.openedAt,
        closedAt: r.closedAt,
      }));
    });
  }

  private async openUnderageCase(
    tx: TenantTxClient,
    workerId: string,
    source: 'review' | 'birth_date_correction' | 'report',
    report?: { code: string; text: string },
  ): Promise<void> {
    const open = await tx.workerComplianceCase.count({
      where: { workerId, kind: 'underage', status: 'open' },
    });
    if (open) return;
    const worker = await tx.domesticWorker.findUniqueOrThrow({
      where: { id: workerId },
      select: { tenantId: true },
    });
    const id = newId();
    await tx.workerComplianceCase.create({
      data: {
        id,
        tenantId: worker.tenantId,
        workerId,
        kind: 'underage',
        source,
        reasonCode: report?.code ?? null,
        note: report?.text ?? null,
        openedById: this.ctx.accountId,
      },
    });
    await this.audit.record(tx, {
      action: 'worker.compliance_case_opened',
      targetId: workerId,
      metadata: {
        caseId: id,
        kind: 'underage',
        source,
        ...(report ? { reasonCode: report.code } : {}),
      },
    });
    // Reported to compliance, not left to the resident alone (11 §7).
    const holders = await this.staff.holding(tx, 'workers.compliance');
    const place = await this.notifier.place(tx, worker.tenantId);
    if (holders.length) {
      await this.notifier.toAccounts(
        tx,
        worker.tenantId,
        holders.map((r) => r.id),
        COMMUNITY_NOTICES.complianceCaseOpened,
        { ...place, caseId: id },
      );
    } else {
      await this.notifier.undeliverable(
        tx,
        worker.tenantId,
        COMMUNITY_NOTICES.complianceCaseOpened,
      );
    }
  }

  private async underCompliance(tx: TenantTxClient, workerId: string) {
    return (
      (await tx.workerComplianceCase.count({
        where: { workerId, kind: 'underage', status: 'open' },
      })) > 0
    );
  }

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
    // The file is not closed before the wage is settled (11 §7): payroll
    // finds it here. Only for someone who could actually have worked.
    if (e.codeIssuedAt) {
      await this.recordObligation(tx, e, 'settle_before_close');
    }
  }

  /** Once per (engagement, kind) while unsettled; audited when new. */
  async recordObligation(
    tx: TenantTxClient,
    e: { id: string; tenantId: string; workerId: string; unitId: string },
    kind: WageObligationKind,
  ): Promise<void> {
    const open = await tx.workerWageObligation.count({
      where: { engagementId: e.id, kind, settledAt: null },
    });
    if (open) return;
    const id = newId();
    await tx.workerWageObligation.create({
      data: {
        id,
        tenantId: e.tenantId,
        engagementId: e.id,
        workerId: e.workerId,
        kind,
      },
    });
    await this.audit.record(tx, {
      action: 'worker.wage_obligation_recorded',
      targetId: e.id,
      metadata: {
        obligationId: id,
        kind,
        workerId: e.workerId,
        unitId: e.unitId,
      },
    });
  }

  /**
   * The account that registered these workers is being erased (ADR 0023):
   * each open engagement it requested ends, with a notice to the worker
   * and, where a code was issued, a wage obligation for payroll.
   */
  async endAllRequestedBy(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<number> {
    const open = await tx.workerEngagement.findMany({
      where: { requestedById: accountId, status: { in: OPEN } },
    });
    for (const e of open) {
      await lockUnits(tx, [e.unitId]);
      if (await this.expireIfDue(tx, e)) continue;
      await this.close(tx, e, 'requester_erased');
      await this.record(tx, e, 'worker.engagement_ended', 'ended', null, {
        reason: 'requester_erased',
      });
    }
    return open.length;
  }

  /**
   * The unit's household ended (ADR 0021): every open engagement ends, in
   * the caller's transaction, each with its notice and wage obligation.
   */
  async endAllForUnit(
    tx: TenantTxClient,
    unitId: string,
    reason: string,
  ): Promise<number> {
    const open = await tx.workerEngagement.findMany({
      where: { unitId, status: { in: OPEN } },
    });
    for (const e of open) {
      if (await this.expireIfDue(tx, e)) continue;
      await this.close(tx, e, reason);
      await this.record(tx, e, 'worker.engagement_ended', 'ended', null, {
        reason,
      });
    }
    return open.length;
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
  const checked = checkIdentityDocument(input);
  if ('fields' in checked) fields.push(...checked.fields);
  const document = 'document' in checked ? checked.document : null;
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
  if (fields.length || !document || !phone) {
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid worker', {
      fields,
    });
  }
  // No override of any kind: not by a manager, not by a flag. For a
  // passport this is the entered date; the manager attests it at approval.
  if (!isAdult(document.birthDate)) throw underage();
  return {
    fullName,
    phone,
    document,
    capacity: input.capacity,
    schedule,
    validUntil,
  };
}

function validBirthDate(raw: Date | string) {
  const checked = checkBirthDate(raw);
  if ('field' in checked) throw invalidDocument([checked.field]);
  return checked.date;
}

function underage() {
  return appError.badRequest(
    ErrorCode.WORKER_UNDERAGE,
    'Domestic workers must be adults',
    { params: { minAge: ADULT_AGE } },
  );
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

function complianceHold() {
  return appError.conflict(
    ErrorCode.WORKER_COMPLIANCE_HOLD,
    'An underage compliance case is open for this worker',
  );
}

function caseNotFound() {
  return appError.notFound(
    ErrorCode.COMPLIANCE_CASE_NOT_FOUND,
    'Compliance case not found',
  );
}

function incidentNotFound() {
  return appError.notFound(
    ErrorCode.CARD_INCIDENT_NOT_FOUND,
    'Card incident not found',
  );
}

function workerNotFound() {
  return appError.notFound(ErrorCode.WORKER_NOT_FOUND, 'Worker not found');
}
