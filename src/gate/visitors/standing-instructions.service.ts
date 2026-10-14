import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  StandingInstructionAction,
  UnitStandingInstruction,
} from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';

export const STANDING_INSTRUCTION_RESOURCE = 'standing_instruction';
/** Instructions per unit: a household's handful of regulars. */
export const MAX_STANDING_INSTRUCTIONS = 20;
export const DESCRIPTION_LENGTH = { min: 1, max: 140 } as const;

/** What the household reads: the instruction and who wrote it. */
export interface StandingInstructionItem {
  id: string;
  description: string;
  action: StandingInstructionAction;
  /** What the guard is shown: `call_first` while `always_allow` is off. */
  effectiveAction: StandingInstructionAction;
  createdBy: { id: string; fullName: string | null; status: string };
  createdAt: Date;
}

/** What the guard reads (ADR 0043): the words and the action, nothing else. */
export interface GuardInstruction {
  id: string;
  description: string;
  action: StandingInstructionAction;
}

export const instructionNotFound = () =>
  appError.notFound(
    ErrorCode.STANDING_INSTRUCTION_NOT_FOUND,
    'Standing instruction not found',
  );

/**
 * A household's standing instructions for the gate (ADR 0043): a few words
 * about someone who may come without a pass, and what the guard does then
 * (`always_allow`, `never_allow`, `call_first`, `leave_at_gate`).
 *
 * - Written and read by those who may invite visitors on the unit
 *   (capabilities.visitorsInvite), at most 20 per unit; deleted by their
 *   author while still an inviter there, or by the unit's primary.
 * - An instruction speaks for the unit only while its author may still
 *   invite there: the guard never sees, and cannot apply, one whose author
 *   left, lost the permission, was deactivated or frozen.
 * - The compound's `allowAlwaysAllow` (default on): while it is off, no
 *   `always_allow` is written and the guard sees those that exist as
 *   `call_first`.
 * - `description` is personal free text: the audit trail records ids and
 *   actions only, no notification carries it, its author's erasure deletes
 *   the row, and the author's export lists it.
 */
@Injectable()
export class StandingInstructionsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly community: CommunityGatePort,
    private readonly settings: TenantSettingsService,
    private readonly idempotency: IdempotencyService,
    private readonly lifecycle: AccountLifecycle,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(STANDING_INSTRUCTION_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const row = await tx.unitStandingInstruction.findUnique({
          where: { id },
          include: { createdBy: AUTHOR },
        });
        // Deleted since: what the first call created is gone.
        if (!row) throw instructionNotFound();
        return this.item(row, await this.allowsAlways(tx));
      }),
    );
    // The author's words go with them (ADR 0023), in the erasure's
    // transaction.
    this.lifecycle.onErasing(async (tx, account) => {
      const rows = await tx.unitStandingInstruction.findMany({
        where: { createdById: account.id },
      });
      for (const row of rows) await this.remove(tx, row, 'author_erased');
      return [];
    });
  }

  list(unitId: string): Promise<StandingInstructionItem[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.requireInviter(tx, unitId);
      const always = await this.allowsAlways(tx);
      const rows = await tx.unitStandingInstruction.findMany({
        where: { unitId },
        include: { createdBy: AUTHOR },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return rows.map((r) => this.item(r, always));
    });
  }

  create(
    unitId: string,
    input: { description: string; action: StandingInstructionAction },
  ): Promise<StandingInstructionItem> {
    const tenantId = this.ctx.tenantId;
    const me = this.ctx.accountId;
    const description = input.description.trim().replace(/\s+/g, ' ');
    if (
      description.length < DESCRIPTION_LENGTH.min ||
      description.length > DESCRIPTION_LENGTH.max
    )
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid standing instruction',
        {
          fields: [
            {
              field: 'description',
              code: FieldErrorCode.INVALID_LENGTH,
              params: { ...DESCRIPTION_LENGTH },
            },
          ],
        },
      );
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, {
        type: STANDING_INSTRUCTION_RESOURCE,
        id,
      });
      await this.requireInviter(tx, unitId);
      const always = await this.allowsAlways(tx);
      if (input.action === 'always_allow' && !always)
        throw appError.conflict(
          ErrorCode.ALWAYS_ALLOW_DISABLED,
          'The compound does not allow "always allow" instructions',
        );
      await this.community.lockUnit(tx, unitId);
      const count = await tx.unitStandingInstruction.count({
        where: { unitId },
      });
      if (count >= MAX_STANDING_INSTRUCTIONS)
        throw appError.conflict(
          ErrorCode.STANDING_INSTRUCTION_LIMIT_REACHED,
          'This unit has as many standing instructions as allowed',
          { params: { max: MAX_STANDING_INSTRUCTIONS } },
        );
      const row = await tx.unitStandingInstruction.create({
        data: {
          id,
          tenantId,
          unitId,
          description,
          action: input.action,
          createdById: me,
        },
        include: { createdBy: AUTHOR },
      });
      await this.audit.record(tx, {
        action: 'standing_instruction.created',
        targetId: id,
        metadata: { unitId, action: input.action },
      });
      return this.item(row, always);
    });
  }

  /** Its author while still an inviter on the unit, or the unit's primary. */
  delete(unitId: string, id: string): Promise<void> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.requireInviter(tx, unitId);
      const row = await tx.unitStandingInstruction.findUnique({
        where: { id },
      });
      if (!row || row.unitId !== unitId) throw instructionNotFound();
      if (
        row.createdById !== me &&
        !(await this.community.isPrimary(tx, unitId, me))
      )
        throw appError.forbidden(
          ErrorCode.FORBIDDEN,
          'Only its author or the unit’s primary can delete it',
        );
      await this.remove(tx, row, 'deleted');
    });
  }

  /**
   * The unit's instructions as the guard sees them (ADR 0043), in the
   * caller's transaction: those whose author may still invite there, each
   * with the action to follow.
   */
  async forGuard(
    tx: TenantTxClient,
    unitId: string,
  ): Promise<GuardInstruction[]> {
    const always = await this.allowsAlways(tx);
    const rows = await tx.unitStandingInstruction.findMany({
      where: { unitId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const out: GuardInstruction[] = [];
    for (const r of rows)
      if (await this.speaksForUnit(tx, r))
        out.push({
          id: r.id,
          description: r.description,
          action: effective(r.action, always),
        });
    return out;
  }

  /**
   * One instruction the guard may apply to a request for `unitId`, with its
   * action to follow; anything else is "not found".
   */
  async applicable(
    tx: TenantTxClient,
    unitId: string,
    id: string,
  ): Promise<GuardInstruction> {
    const row = await tx.unitStandingInstruction.findUnique({ where: { id } });
    if (!row || row.unitId !== unitId || !(await this.speaksForUnit(tx, row)))
      throw instructionNotFound();
    return {
      id: row.id,
      description: row.description,
      action: effective(row.action, await this.allowsAlways(tx)),
    };
  }

  private async remove(
    tx: TenantTxClient,
    row: UnitStandingInstruction,
    reasonCode: 'deleted' | 'author_erased',
  ): Promise<void> {
    const { count } = await tx.unitStandingInstruction.deleteMany({
      where: { id: row.id },
    });
    if (!count) return;
    await this.audit.record(tx, {
      action: 'standing_instruction.deleted',
      targetId: row.id,
      metadata: { unitId: row.unitId, action: row.action, reasonCode },
    });
  }

  private async speaksForUnit(
    tx: TenantTxClient,
    row: UnitStandingInstruction,
  ): Promise<boolean> {
    const caps = await this.community.placeIn(tx, row.createdById, row.unitId);
    return caps?.visitorsInvite === true;
  }

  private async allowsAlways(tx: TenantTxClient): Promise<boolean> {
    return (await this.settings.inTx(tx, this.ctx.tenantId)).allowAlwaysAllow;
  }

  /** visitorsInvite on the unit; no place at all is "not found". */
  private async requireInviter(tx: TenantTxClient, unitId: string) {
    const caps = await this.community.placeIn(tx, this.ctx.accountId, unitId);
    if (!caps)
      throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
    if (!caps.visitorsInvite)
      throw appError.forbidden(
        ErrorCode.FORBIDDEN,
        'You cannot invite visitors to this unit',
      );
  }

  private item(
    r: UnitStandingInstruction & {
      createdBy: { id: string; fullName: string | null; status: string };
    },
    always: boolean,
  ): StandingInstructionItem {
    return {
      id: r.id,
      description: r.description,
      action: r.action,
      effectiveAction: effective(r.action, always),
      createdBy: r.createdBy,
      createdAt: r.createdAt,
    };
  }
}

const AUTHOR = { select: { id: true, fullName: true, status: true } } as const;

/** `always_allow` reads as `call_first` while the compound forbids it. */
function effective(
  action: StandingInstructionAction,
  allowAlways: boolean,
): StandingInstructionAction {
  return action === 'always_allow' && !allowAlways ? 'call_first' : action;
}
