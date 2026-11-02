import { Injectable } from '@nestjs/common';
import { Prisma, type ExperienceCompensation } from '@prisma/client';
import { StaffRecipients } from '../access/staff-recipients';
import { AuditService } from '../audit/audit.service';
import { diffChanges } from '../audit/diff';
import { BoardMatters } from '../board-matters/board-matters';
import { RequestContext } from '../common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../common/cursor';
import { FieldErrorCode, type FieldError } from '../common/errors';
import { invalid } from '../common/localized';
import { REASON_CODES, requireReasonCodeOnly } from '../common/reasons';
import { newId } from '../common/uuid';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { Notifier } from '../notifications/notifier';
import { reference } from '../staff-inbox/staff-inbox';
import { CompensationCredits } from './compensation-credits';
import { CASE_PREFIX } from './experience-cases.service';
import {
  clock,
  compensationNotFound,
  lockOpenCase,
  lockProposed,
  lockSelf,
} from './experience-locks';

export const COMPENSATION_KINDS = [
  'credit',
  'apology',
  'redo',
  'priority',
] as const;
export type CompensationKind = (typeof COMPENSATION_KINDS)[number];
export const COMPENSATION_STATUSES = [
  'proposed',
  'approved',
  'rejected',
] as const;
export type CompensationStatus = (typeof COMPENSATION_STATUSES)[number];
export const COMPENSATION_NOTE = { min: 1, max: 1000 } as const;
/** The approval type above the manager's limit (ADR 0055, 0073). */
export const COMPENSATION_APPROVAL = 'compensation_above_limit' as const;
/** Hours to decide one, unless the compound set its own in the inbox. */
export const COMPENSATION_DUE_HOURS = 24;

const PAGE = keysetCursor('proposedAt', 'asc');

export interface CompensationRule {
  failureCode: string;
  kind: CompensationKind;
  amount: string | null;
}

/** Above the board's threshold the board decides; the manager otherwise. */
export interface CompensationAuthority {
  threshold: string | null;
  binding: boolean;
  decider: 'manager' | 'board';
}

/**
 * Compensations on a case (ADR 0082). The staff with `experience.manage`
 * propose one on an open case: what failed (the compensation reasons of
 * ADR 0058), the kind (a credit names its amount; an apology, a redo or a
 * priority on the next service move no money) and a note. The manager
 * (`experience.compensate`, never a deputy) decides it once, under its row's
 * lock: two decisions at once, one wins (COMPENSATION_DECIDED).
 *
 * An approved credit is a credit note through finance on one of the unit's
 * invoices (the compensation credits port), not a ledger of its own; above
 * `compensation_above_limit`'s binding threshold it names what the board
 * approved (ADR 0073: an approval request of the type, raised and decided
 * on the board's own path), used once, so a compensation above the limit is
 * never paid before the board approves it. The compound's rules recommend a
 * kind and an amount per failure.
 */
@Injectable()
export class CompensationsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly recipients: StaffRecipients,
    private readonly matters: BoardMatters,
    private readonly credits: CompensationCredits,
  ) {}

  list(q: {
    status?: CompensationStatus;
    caseId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<ExperienceCompensation>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.experienceCompensation.findMany({
        where: {
          AND: [
            q.status ? { status: q.status } : {},
            q.caseId ? { caseId: q.caseId } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  get(id: string): Promise<ExperienceCompensation> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.experienceCompensation.findUnique({ where: { id } });
      if (!row) throw compensationNotFound();
      return row;
    });
  }

  /** The threshold now, whether it binds, and who decides `amount`. */
  authority(amount: string | null): Promise<CompensationAuthority> {
    return this.tenantTx.withTenantTx((tx) => this.authorityIn(tx, amount));
  }

  async authorityIn(
    tx: TenantTxClient,
    amount: string | null,
  ): Promise<CompensationAuthority> {
    const threshold = await this.matters.threshold(tx, COMPENSATION_APPROVAL);
    const binding = await this.matters.binding(tx, COMPENSATION_APPROVAL);
    const above =
      binding &&
      threshold !== null &&
      amount !== null &&
      new Prisma.Decimal(amount).gt(new Prisma.Decimal(threshold));
    return { threshold, binding, decider: above ? 'board' : 'manager' };
  }

  propose(
    caseId: string,
    input: {
      kind: CompensationKind;
      failureCode: string;
      amount?: string | null;
      note?: string | null;
    },
  ): Promise<ExperienceCompensation> {
    // The DTO holds it to `creditNoteCompensation`.
    const failureCode = input.failureCode;
    const fields: FieldError[] = [];
    if (input.kind === 'credit' && !input.amount)
      fields.push({ field: 'amount', code: FieldErrorCode.FIELD_REQUIRED });
    if (input.kind !== 'credit' && input.amount)
      fields.push({ field: 'amount', code: FieldErrorCode.FIELD_NOT_ALLOWED });
    if (fields.length) throw invalid(fields);
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await lockSelf(tx, me);
      const found = await lockOpenCase(tx, caseId, 'share');
      const id = newId();
      const row = await tx.experienceCompensation.create({
        data: {
          id,
          tenantId: found.tenantId,
          caseId,
          unitId: found.unitId,
          kind: input.kind,
          failureCode,
          amount: input.kind === 'credit' ? input.amount! : null,
          note: input.note?.trim() || null,
          proposedById: me,
          proposedAt: await clock(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'experience_compensation.proposed',
        targetId: id,
        metadata: {
          caseId,
          unitId: found.unitId,
          kind: input.kind,
          failureCode,
          ...(row.amount ? { amount: row.amount.toFixed(2) } : {}),
        },
      });
      const to = (
        await this.recipients.holding(tx, 'experience.compensate')
      ).map((r) => r.id);
      await this.notifier.notify(
        tx,
        to.filter((a) => a !== me),
        {
          kind: 'experience_compensation.proposed',
          params: {
            caseNumber: reference(CASE_PREFIX, found.number)!,
            compensationKind: input.kind,
          },
          targetId: id,
        },
      );
      return row;
    });
  }

  /**
   * Approved: a credit is issued now on `invoiceId` (one of the unit's),
   * naming `authorizationId` above the binding threshold; the other kinds
   * are recorded. Rejected: with a code. Once, under the row's lock.
   */
  decide(
    id: string,
    input: {
      decision: 'approve' | 'reject';
      invoiceId?: string;
      authorizationId?: string;
      reasonCode?: string;
    },
  ): Promise<ExperienceCompensation> {
    const me = this.ctx.accountId;
    const rejectReason =
      input.decision === 'reject'
        ? requireReasonCodeOnly(
            input.reasonCode,
            REASON_CODES.compensationReject,
          )
        : null;
    const fields: FieldError[] = [];
    if (input.decision === 'reject') {
      if (input.invoiceId)
        fields.push({
          field: 'invoiceId',
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        });
      if (input.authorizationId)
        fields.push({
          field: 'authorizationId',
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        });
    } else if (input.reasonCode)
      fields.push({
        field: 'reasonCode',
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      await lockSelf(tx, me);
      const peek = await tx.experienceCompensation.findUnique({
        where: { id },
        select: { caseId: true },
      });
      if (!peek) throw compensationNotFound();
      // The case first (a close waits for the decision), then the row. A
      // proposed one's case is open: a close refuses while one waits.
      await tx.$queryRaw`SELECT id FROM experience_cases WHERE id = ${peek.caseId}::uuid FOR SHARE`;
      const comp = await lockProposed(tx, id);
      const now = await clock(tx);
      if (rejectReason) {
        const row = await tx.experienceCompensation.update({
          where: { id },
          data: {
            status: 'rejected',
            decidedById: me,
            decidedAt: now,
            rejectReason,
          },
        });
        await this.audit.record(tx, {
          action: 'experience_compensation.rejected',
          targetId: id,
          metadata: { caseId: comp.caseId, reasonCode: rejectReason },
        });
        return row;
      }
      if (comp.kind !== 'credit') {
        const extra: FieldError[] = [];
        if (input.invoiceId)
          extra.push({
            field: 'invoiceId',
            code: FieldErrorCode.FIELD_NOT_ALLOWED,
          });
        if (input.authorizationId)
          extra.push({
            field: 'authorizationId',
            code: FieldErrorCode.FIELD_NOT_ALLOWED,
          });
        if (extra.length) throw invalid(extra);
      } else if (!input.invoiceId)
        throw invalid([
          { field: 'invoiceId', code: FieldErrorCode.FIELD_REQUIRED },
        ]);
      const issued =
        comp.kind === 'credit'
          ? await this.credits.credit(tx, {
              compensationId: id,
              unitId: comp.unitId,
              invoiceId: input.invoiceId!,
              amount: comp.amount!,
              failureCode: comp.failureCode,
              authorizationId: input.authorizationId ?? null,
            })
          : null;
      const row = await tx.experienceCompensation.update({
        where: { id },
        data: {
          status: 'approved',
          decidedById: me,
          decidedAt: now,
          creditNoteId: issued?.creditNoteId ?? null,
          authorizationId: issued?.authorizationId ?? null,
        },
      });
      await this.audit.record(tx, {
        action: 'experience_compensation.approved',
        targetId: id,
        metadata: {
          caseId: comp.caseId,
          kind: comp.kind,
          ...(comp.amount ? { amount: comp.amount.toFixed(2) } : {}),
          ...(issued
            ? {
                creditNoteId: issued.creditNoteId,
                creditNoteNumber: issued.number,
                authorizationId: issued.authorizationId,
              }
            : {}),
        },
      });
      return row;
    });
  }

  // --------------------------------------------------------------------------
  // The rules: one per failure code
  // --------------------------------------------------------------------------

  rules(): Promise<CompensationRule[]> {
    return this.tenantTx.withTenantTx((tx) => this.rulesIn(tx));
  }

  async rulesIn(tx: TenantTxClient): Promise<CompensationRule[]> {
    const rows = await tx.experienceCompensationRule.findMany({
      orderBy: { failureCode: 'asc' },
    });
    return rows.map((r) => ({
      failureCode: r.failureCode,
      kind: r.kind as CompensationKind,
      amount: r.amount?.toFixed(2) ?? null,
    }));
  }

  /** Sets the given codes' rules; `kind: null` removes one. */
  setRules(
    items: {
      failureCode: string;
      kind: CompensationKind | null;
      amount?: string | null;
    }[],
  ): Promise<CompensationRule[]> {
    const fields: FieldError[] = [];
    const seen = new Set<string>();
    items.forEach((item, i) => {
      if (
        !(REASON_CODES.creditNoteCompensation as readonly string[]).includes(
          item.failureCode,
        )
      )
        fields.push({
          field: `items[${i}].failureCode`,
          code: FieldErrorCode.INVALID_REASON_CODE,
          params: { allowed: [...REASON_CODES.creditNoteCompensation] },
        });
      if (seen.has(item.failureCode))
        fields.push({
          field: `items[${i}].failureCode`,
          code: FieldErrorCode.DUPLICATE_VALUE,
        });
      seen.add(item.failureCode);
      if (item.kind === 'credit' && !item.amount)
        fields.push({
          field: `items[${i}].amount`,
          code: FieldErrorCode.FIELD_REQUIRED,
        });
      if (item.kind !== 'credit' && item.amount)
        fields.push({
          field: `items[${i}].amount`,
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        });
    });
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      const tenantId = this.ctx.txTenantId;
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`experience-rules:${tenantId}`}))`;
      const before = await this.rulesIn(tx);
      for (const item of items) {
        if (item.kind === null)
          await tx.experienceCompensationRule.deleteMany({
            where: { failureCode: item.failureCode },
          });
        else {
          const data = {
            kind: item.kind,
            amount: item.kind === 'credit' ? item.amount! : null,
          };
          await tx.experienceCompensationRule.upsert({
            where: {
              tenantId_failureCode: {
                tenantId,
                failureCode: item.failureCode,
              },
            },
            create: { tenantId, failureCode: item.failureCode, ...data },
            update: { ...data, updatedAt: new Date() },
          });
        }
      }
      const after = await this.rulesIn(tx);
      const changes = diffChanges(
        flatRules(before),
        flatRules(after),
        'experience.compensation_rules_changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'experience.compensation_rules_changed',
          targetId: tenantId,
          changes,
        });
      return after;
    });
  }
}

function flatRules(rules: CompensationRule[]): Record<string, unknown> {
  return Object.fromEntries(
    rules.flatMap((r): [string, unknown][] => [
      [`${r.failureCode}.kind`, r.kind],
      [`${r.failureCode}.amount`, r.amount],
    ]),
  );
}
