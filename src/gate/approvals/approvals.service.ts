import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  GateApprovalRequest,
  GateDecisionSource,
  GateRequestKind,
  GateRequestStatus,
} from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import type { AppClsStore } from '../../core/common/cls/app-cls';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { GateSubjects } from '../entries/subjects';
import { ShiftsService } from '../shifts/shifts.service';
import { InstructionsService } from '../visitors/instructions.service';
import { VISITOR_DATA_DAYS } from '../visitors/visitor-passes.service';

export const REQUEST_RESOURCE = 'gate_approval_request';
export const REQUEST_TIMEOUTS_SWEEP = 'gate.request_timeouts';
const DAY = 86_400_000;

export type NewRequest =
  | {
      kind: 'uninvited_visitor' | 'delivery';
      unitCode: string;
      partySize?: number;
      visitorName?: string;
    }
  | { kind: 'worker_off_schedule'; engagementId: string };

/** What the guard sees: never who decided, never a resident. */
export interface GuardRequestView {
  id: string;
  kind: GateRequestKind;
  unitCode: string;
  partySize: number;
  status: GateRequestStatus;
  decisionSource: GateDecisionSource | null;
  expiresAt: Date;
  createdAt: Date;
}

/** What the household sees: never the guard. */
export interface HostRequestView {
  id: string;
  kind: GateRequestKind;
  unitId: string;
  unitCode: string;
  gateName: string;
  partySize: number;
  visitorName: string | null;
  workerName: string | null;
  expiresAt: Date;
  createdAt: Date;
}

export const requestNotFound = () =>
  appError.notFound(ErrorCode.GATE_REQUEST_NOT_FOUND, 'Gate request not found');

const decided = (status: GateRequestStatus) =>
  appError.conflict(
    ErrorCode.GATE_REQUEST_DECIDED,
    'This request has already been decided',
    { params: { status } },
  );

/**
 * Approvals at the gate (ADR 0028). The guard asks; every account that may
 * invite visitors on the unit (capabilities.visitorsInvite) is told,
 * critically, and may answer. Rules:
 * - the first decision wins (a conditional update under the row lock);
 * - a household's deny wins over its approval until the entry is recorded
 *   (the entry takes the same row lock), and the guard is told at once;
 * - nobody answering in time applies the unit's standing instruction —
 *   resolved lazily on every read, decision and entry, and by the sweep.
 */
@Injectable()
export class ApprovalsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly cls: ClsService<AppClsStore>,
    private readonly shifts: ShiftsService,
    private readonly community: CommunityGatePort,
    private readonly subjects: GateSubjects,
    private readonly instructions: InstructionsService,
    private readonly settings: TenantSettingsService,
    private readonly notifier: Notifier,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly sweep: SweepRunner,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(REQUEST_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.guardView(
          tx,
          await tx.gateApprovalRequest.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
    this.sweep.register(REQUEST_TIMEOUTS_SWEEP, (now) =>
      this.sweep.forEachTenant(async (tx) => {
        const due = await tx.gateApprovalRequest.findMany({
          where: { status: 'pending', expiresAt: { lte: now } },
          select: { id: true },
        });
        let done = 0;
        for (const r of due) if (await this.resolveDue(tx, r.id, now)) done++;
        return done;
      }),
    );
  }

  // --------------------------------------------------------------------------
  // The guard (`gate.operate`, inside a shift)
  // --------------------------------------------------------------------------

  request(input: NewRequest): Promise<GuardRequestView> {
    const tenantId = this.ctx.tenantId;
    const guardId = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const shift = await this.shifts.requireOpen(tx);
      const id = newId();
      await this.idempotency.claim(tx, { type: REQUEST_RESOURCE, id });
      const now = new Date();
      let unitId: string;
      let unitCode: string;
      let partySize = 1;
      let engagementId: string | null = null;
      let workerName: string | null = null;
      let visitorName: string | null = null;
      if (input.kind === 'worker_off_schedule') {
        const e = await this.community.engagementById(tx, input.engagementId);
        if (!e)
          throw appError.notFound(
            ErrorCode.ENGAGEMENT_NOT_FOUND,
            'Engagement not found',
          );
        const tz = (await this.settings.inTx(tx, tenantId)).timezone;
        const refusal = await this.subjects.refusal(
          tx,
          this.subjects.worker(e),
          now,
          tz,
        );
        // Only the schedule is the household's to waive.
        if (refusal === null)
          throw appError.conflict(
            ErrorCode.GATE_REQUEST_NOT_NEEDED,
            'The worker may come in: no approval is needed',
          );
        if (refusal !== 'outside_schedule')
          throw appError.conflict(
            ErrorCode.GATE_ENTRY_REFUSED,
            'They may not come in',
            { params: { reason: refusal } },
          );
        unitId = e.unitId;
        unitCode = e.unitCode;
        engagementId = e.engagementId;
        workerName = e.workerName;
      } else {
        const unit = await this.community.unitByCode(tx, input.unitCode);
        if (!unit)
          throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
        unitId = unit.id;
        unitCode = unit.code;
        partySize = input.partySize ?? 1;
        visitorName = input.visitorName?.trim() || null;
      }
      let detailsId: string | null = null;
      if (visitorName) {
        detailsId = newId();
        await tx.visitorDetails.create({
          data: {
            id: detailsId,
            tenantId,
            fullName: visitorName,
            expiresAt: new Date(now.getTime() + VISITOR_DATA_DAYS * DAY),
          },
        });
      }
      const timeout = (await this.settings.inTx(tx, tenantId))
        .gateRequestTimeoutSeconds;
      const request = await tx.gateApprovalRequest.create({
        data: {
          id,
          tenantId,
          unitId,
          gateId: shift.gateId,
          shiftId: shift.id,
          requestedById: guardId,
          kind: input.kind,
          partySize,
          engagementId,
          visitorDetailsId: detailsId,
          expiresAt: new Date(now.getTime() + timeout * 1000),
        },
      });
      await this.audit.record(tx, {
        action: 'gate.approval_requested',
        targetId: id,
        metadata: { unitId, kind: input.kind, partySize, gateId: shift.gateId },
      });
      const holders = await this.community.holders(
        tx,
        unitId,
        'visitorsInvite',
      );
      await this.notifier.notify(tx, holders, {
        kind: 'gate.approval_requested',
        params: {
          unitCode,
          requestKind: input.kind,
          partySize,
          gateName: shift.gateName,
          ...(visitorName ? { visitorName } : {}),
          ...(workerName ? { workerName } : {}),
        },
        targetId: id,
      });
      return this.guardView(tx, request, unitCode);
    });
  }

  /** The guard follows the answer; a timeout is applied on the way. */
  forGuard(id: string): Promise<GuardRequestView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const request = await this.lockedResolved(tx, id);
      return this.guardView(tx, request);
    });
  }

  withdraw(id: string): Promise<GuardRequestView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.shifts.requireOpen(tx);
      const found = await tx.gateApprovalRequest.findUnique({ where: { id } });
      if (!found) throw requestNotFound();
      await this.idempotency.claim(tx, { type: REQUEST_RESOURCE, id });
      const request = await this.lockedResolved(tx, id);
      if (request.status !== 'pending') throw decided(request.status);
      const updated = await tx.gateApprovalRequest.update({
        where: { id },
        data: {
          status: 'withdrawn',
          decidedAt: new Date(),
          decisionSource: 'guard',
        },
      });
      await this.audit.record(tx, {
        action: 'gate.approval_withdrawn',
        targetId: id,
      });
      return this.guardView(tx, updated);
    });
  }

  // --------------------------------------------------------------------------
  // The household (capabilities.visitorsInvite on the unit)
  // --------------------------------------------------------------------------

  /** Pending requests the caller may answer, oldest first. */
  mine(): Promise<HostRequestView[]> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const units = await this.community.unitsWhere(tx, me, 'visitorsInvite');
      if (!units.length) return [];
      const rows = await tx.gateApprovalRequest.findMany({
        where: {
          unitId: { in: units },
          status: 'pending',
          expiresAt: { gt: new Date() },
        },
        include: {
          gate: { select: { name: true } },
          visitorDetails: { select: { fullName: true } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const codes = await this.community.unitCodes(
        tx,
        rows.map((r) => r.unitId),
      );
      const out: HostRequestView[] = [];
      for (const r of rows) {
        const worker = r.engagementId
          ? await this.community.engagementById(tx, r.engagementId)
          : null;
        out.push({
          id: r.id,
          kind: r.kind,
          unitId: r.unitId,
          unitCode: codes.get(r.unitId) ?? '',
          gateName: r.gate.name,
          partySize: r.partySize,
          visitorName: r.visitorDetails?.fullName ?? null,
          workerName: worker?.workerName ?? null,
          expiresAt: r.expiresAt,
          createdAt: r.createdAt,
        });
      }
      return out;
    });
  }

  decide(
    id: string,
    decision: 'approve' | 'deny',
  ): Promise<{
    id: string;
    status: GateRequestStatus;
    decisionSource: GateDecisionSource | null;
  }> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.gateApprovalRequest.findUnique({ where: { id } });
      if (!found) throw requestNotFound();
      const caps = await this.community.placeIn(tx, me, found.unitId);
      if (!caps?.visitorsInvite) throw requestNotFound();
      const request = await this.lockedResolved(tx, id);
      if (request.status === 'pending') {
        const status = decision === 'approve' ? 'approved' : 'denied';
        const updated = await tx.gateApprovalRequest.update({
          where: { id },
          data: {
            status,
            decidedById: me,
            decidedAt: new Date(),
            decisionSource: 'household',
          },
        });
        await this.audit.record(tx, {
          action: 'gate.approval_decided',
          targetId: id,
          metadata: { decision: status, decisionSource: 'household' },
        });
        return pick(updated);
      }
      // Deny wins over an approval until somebody came in on it.
      if (
        decision === 'deny' &&
        request.status === 'approved' &&
        !(await this.used(tx, id))
      ) {
        const updated = await tx.gateApprovalRequest.update({
          where: { id },
          data: {
            status: 'denied',
            decidedById: me,
            decidedAt: new Date(),
            decisionSource: 'household',
          },
        });
        await this.audit.record(tx, {
          action: 'gate.approval_reversed',
          targetId: id,
          metadata: { from: request.decisionSource },
        });
        await this.notifier.notify(tx, [request.requestedById], {
          kind: 'gate.approval_reversed',
          params: {
            unitCode: await this.community.unitCode(tx, request.unitId),
            requestKind: request.kind,
          },
          targetId: id,
        });
        return pick(updated);
      }
      throw decided(request.status);
    });
  }

  // --------------------------------------------------------------------------
  // Shared with the entries
  // --------------------------------------------------------------------------

  /**
   * The request under its row lock (the one an entry takes too), with a
   * due timeout applied first.
   */
  async lockedResolved(
    tx: TenantTxClient,
    id: string,
  ): Promise<GateApprovalRequest> {
    await tx.$queryRaw`SELECT id FROM gate_approval_requests WHERE id = ${id}::uuid FOR UPDATE`;
    await this.resolveDue(tx, id, new Date());
    const request = await tx.gateApprovalRequest.findUnique({ where: { id } });
    if (!request) throw requestNotFound();
    return request;
  }

  /** Whether an entry was recorded on this approval. */
  async used(tx: TenantTxClient, id: string): Promise<boolean> {
    return (
      (await tx.gateEntry.count({
        where: { approvalRequestId: id, direction: 'in' },
      })) > 0
    );
  }

  /** Applies the standing instruction to a pending request past its time. */
  private async resolveDue(
    tx: TenantTxClient,
    id: string,
    now: Date,
  ): Promise<boolean> {
    const r = await tx.gateApprovalRequest.findUnique({ where: { id } });
    if (!r || r.status !== 'pending' || r.expiresAt > now) return false;
    const rules = await this.instructions.of(tx, r.unitId);
    let status: GateRequestStatus = 'timed_out';
    if (r.kind === 'uninvited_visitor' && rules.uninvitedVisitor !== 'ask')
      status = rules.uninvitedVisitor === 'allow' ? 'approved' : 'denied';
    if (r.kind === 'delivery' && rules.delivery !== 'ask')
      status =
        rules.delivery === 'allow'
          ? 'approved'
          : rules.delivery === 'deny'
            ? 'denied'
            : 'leave_at_gate';
    const source: GateDecisionSource =
      status === 'timed_out' ? 'timeout' : 'standing_instruction';
    const { count } = await tx.gateApprovalRequest.updateMany({
      where: { id, status: 'pending' },
      data: { status, decidedAt: now, decisionSource: source },
    });
    if (!count) return false;
    await this.cls.run({ ifNested: 'inherit' }, async () => {
      this.cls.set('auditActor', { type: 'system', id: null });
      await this.audit.record(tx, {
        action: 'gate.approval_decided',
        targetId: id,
        metadata: { decision: status, decisionSource: source },
      });
    });
    return true;
  }

  private async guardView(
    tx: TenantTxClient,
    r: GateApprovalRequest,
    unitCode?: string,
  ): Promise<GuardRequestView> {
    return {
      id: r.id,
      kind: r.kind,
      unitCode: unitCode ?? (await this.community.unitCode(tx, r.unitId)),
      partySize: r.partySize,
      status: r.status,
      decisionSource: r.decisionSource,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    };
  }
}

function pick(r: GateApprovalRequest) {
  return { id: r.id, status: r.status, decisionSource: r.decisionSource };
}
