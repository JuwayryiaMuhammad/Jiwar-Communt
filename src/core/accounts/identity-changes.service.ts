import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type AccountIdentityChange } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { diffChanges } from '../audit/diff';
import { normalizePhone } from '../auth/identifier';
import { StepUpService } from '../auth/step-up.service';
import { RequestContext } from '../common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../common/reasons';
import { newId } from '../common/uuid';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { Notifier } from '../notifications/notifier';
import { AccountLifecycle } from './account-lifecycle';
import { AccountWriter } from './account-writer';

export const IDENTITY_FIELDS = ['name', 'phone'] as const;
export type IdentityField = (typeof IDENTITY_FIELDS)[number];
export type IdentityChangeStatus =
  'pending' | 'approved' | 'rejected' | 'cancelled';

/** A request as its account sees it: the value only while pending. */
export interface IdentityChangeRead {
  id: string;
  field: IdentityField;
  status: IdentityChangeStatus;
  newValue: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  reasonCode: string | null;
}

/** A pending request as the manager reviews it: who asks, what, and what it replaces. */
export interface IdentityChangeReview extends IdentityChangeRead {
  accountId: string;
  accountType: string;
  currentValue: string | null;
}

const QUEUE = keysetCursor('createdAt', 'asc');
const MINE_LIMIT = 10;

const notFound = () =>
  appError.notFound(
    ErrorCode.IDENTITY_CHANGE_NOT_FOUND,
    'Identity change request not found',
  );

async function dbNow(tx: TenantTxClient): Promise<Date> {
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`
    SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
  return now;
}

/**
 * A name or phone change an account asks for (ADR 0062). The name is the
 * ID document's, which the gate checks; the phone is a login identifier no
 * SMS proves. So the account asks (with a step-up) and a manager with
 * `residents.manage` decides: an approval applies the change as a
 * manager's own edit would (the phone through AccountWriter.updateContact,
 * which refuses a released number), a rejection gives a code. One pending
 * request per account; the value is erased by the decision, a
 * cancellation, or the account's erasure.
 *
 * Lock order: the account FOR UPDATE, then the request FOR UPDATE.
 */
@Injectable()
export class IdentityChangesService implements OnModuleInit {
  constructor(
    private readonly ctx: RequestContext,
    private readonly tenantTx: TenantTx,
    private readonly stepUp: StepUpService,
    private readonly writer: AccountWriter,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly lifecycle: AccountLifecycle,
  ) {}

  onModuleInit(): void {
    // An erased account's pending request goes with its value.
    this.lifecycle.onErasing(async (tx, account) => {
      const pending = await tx.accountIdentityChange.findMany({
        where: { accountId: account.id, status: 'pending' },
        select: { id: true },
      });
      const now = await dbNow(tx);
      for (const { id } of pending)
        await tx.accountIdentityChange.update({
          where: { id },
          data: { status: 'cancelled', newValue: null, decidedAt: now },
        });
      return [];
    });
  }

  /** The account asks; a step-up first. One pending at a time. */
  async ask(input: {
    field: string;
    value: string;
  }): Promise<IdentityChangeRead> {
    const field = input.field as IdentityField;
    const value = valueOf(field, input.value);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lockAccount(tx, this.ctx.accountId);
      const me = await tx.account.findUniqueOrThrow({
        where: { id: this.ctx.accountId },
        select: { fullName: true, phone: true },
      });
      if ((field === 'name' ? me.fullName : me.phone) === value)
        throw invalidValue('value', 'The account has this value already');
      const open = await tx.accountIdentityChange.count({
        where: { accountId: this.ctx.accountId, status: 'pending' },
      });
      if (open)
        throw appError.conflict(
          ErrorCode.IDENTITY_CHANGE_PENDING,
          'A request is waiting for the management already',
        );
      await this.stepUp.consume(tx);
      const row = await tx.accountIdentityChange.create({
        data: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          accountId: this.ctx.accountId,
          field,
          newValue: value,
          createdAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'account.identity_change_requested',
        targetId: this.ctx.accountId,
        metadata: { requestId: row.id, field },
      });
      return read(row);
    });
  }

  /** The account's own requests, newest first (the last ten). */
  mine(): Promise<IdentityChangeRead[]> {
    return this.tenantTx.withTenantTx(async (tx) =>
      (
        await tx.accountIdentityChange.findMany({
          where: { accountId: this.ctx.accountId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: MINE_LIMIT,
        })
      ).map(read),
    );
  }

  /** The account withdraws its pending request. */
  async cancel(id: string): Promise<IdentityChangeRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lockAccount(tx, this.ctx.accountId);
      const row = await this.lockedPending(tx, id, this.ctx.accountId);
      const after = await tx.accountIdentityChange.update({
        where: { id: row.id },
        data: {
          status: 'cancelled',
          newValue: null,
          decidedAt: await dbNow(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'account.identity_change_cancelled',
        targetId: row.accountId,
        metadata: { requestId: row.id, field: row.field },
      });
      return read(after);
    });
  }

  /** Pending requests, oldest first, with the value each replaces. */
  async queue(
    q: { cursor?: string; limit?: number } = {},
  ): Promise<Page<IdentityChangeReview>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.accountIdentityChange.findMany({
        where: {
          AND: [
            { status: 'pending' },
            ...(QUEUE.after(
              q.cursor,
            ) as Prisma.AccountIdentityChangeWhereInput[]),
          ],
        },
        include: {
          account: { select: { fullName: true, phone: true, type: true } },
        },
        orderBy: QUEUE.orderBy,
        take: limit + 1,
      });
      const page = QUEUE.toPage(rows, limit);
      return {
        items: page.items.map((r) => ({
          ...read(r),
          accountId: r.accountId,
          accountType: r.account.type,
          currentValue:
            r.field === 'name' ? r.account.fullName : r.account.phone,
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  /**
   * Applies the change. A phone another freeze released is PHONE_RELEASED
   * (the manager rejects it instead); the request stays pending then.
   */
  async approve(id: string): Promise<IdentityChangeRead> {
    return this.decide(id, async (tx, row) => {
      if (row.field === 'phone') {
        await this.writer.updateContact(tx, row.accountId, {
          phone: row.newValue!,
        });
      } else {
        const before = await tx.account.findUniqueOrThrow({
          where: { id: row.accountId },
          select: { fullName: true },
        });
        await tx.account.update({
          where: { id: row.accountId },
          data: { fullName: row.newValue! },
        });
        await this.audit.record(tx, {
          action: 'account.name_changed',
          targetId: row.accountId,
          changes: diffChanges(
            { fullName: before.fullName },
            { fullName: row.newValue },
            'account.name_changed',
          ),
          metadata: { requestId: row.id },
        });
      }
      return { status: 'approved' as const, reasonCode: null };
    });
  }

  async reject(
    id: string,
    input: { reasonCode?: string },
  ): Promise<IdentityChangeRead> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.identityChangeReject,
    );
    return this.decide(id, () =>
      Promise.resolve({ status: 'rejected' as const, reasonCode: reason }),
    );
  }

  // --------------------------------------------------------------------------

  private async decide(
    id: string,
    apply: (
      tx: TenantTxClient,
      row: AccountIdentityChange,
    ) => Promise<{
      status: 'approved' | 'rejected';
      reasonCode: string | null;
    }>,
  ): Promise<IdentityChangeRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.accountIdentityChange.findUnique({
        where: { id },
        select: { accountId: true },
      });
      if (!found) throw notFound();
      await this.lockAccount(tx, found.accountId);
      const row = await this.lockedPending(tx, id);
      const outcome = await apply(tx, row);
      const after = await tx.accountIdentityChange.update({
        where: { id: row.id },
        data: {
          status: outcome.status,
          reasonCode: outcome.reasonCode,
          newValue: null,
          decidedAt: await dbNow(tx),
          decidedBy: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action:
          outcome.status === 'approved'
            ? 'account.identity_change_approved'
            : 'account.identity_change_rejected',
        targetId: row.accountId,
        metadata: {
          requestId: row.id,
          field: row.field,
          ...(outcome.reasonCode ? { reasonCode: outcome.reasonCode } : {}),
        },
      });
      await this.notifier.notify(tx, [row.accountId], {
        kind: 'account.identity_change_decided',
        params: { field: row.field, outcome: outcome.status },
        targetId: row.id,
      });
      return read(after);
    });
  }

  private async lockAccount(tx: TenantTxClient, accountId: string) {
    await tx.$queryRaw`SELECT id FROM accounts
       WHERE id = ${accountId}::uuid FOR UPDATE`;
  }

  /** The pending request, locked; the account's own when `accountId` is given. */
  private async lockedPending(
    tx: TenantTxClient,
    id: string,
    accountId?: string,
  ): Promise<AccountIdentityChange> {
    await tx.$queryRaw`SELECT id FROM account_identity_changes
       WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await tx.accountIdentityChange.findUnique({ where: { id } });
    if (!row || (accountId && row.accountId !== accountId)) throw notFound();
    if (row.status !== 'pending')
      throw appError.conflict(
        ErrorCode.IDENTITY_CHANGE_DECIDED,
        'The request was decided or withdrawn already',
      );
    return row;
  }
}

function read(r: AccountIdentityChange): IdentityChangeRead {
  return {
    id: r.id,
    field: r.field as IdentityField,
    status: r.status as IdentityChangeStatus,
    newValue: r.newValue,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
    reasonCode: r.reasonCode,
  };
}

/** The value in its stored shape: a trimmed name, a phone in E.164. */
function valueOf(field: IdentityField, raw: string): string {
  if (!(IDENTITY_FIELDS as readonly string[]).includes(field))
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid field', {
      fields: [
        {
          field: 'field',
          code: FieldErrorCode.INVALID_VALUE,
          params: { allowed: [...IDENTITY_FIELDS] },
        },
      ],
    });
  if (field === 'phone') {
    const phone = normalizePhone(raw ?? '');
    if (!phone)
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid phone', {
        fields: [{ field: 'value', code: FieldErrorCode.INVALID_PHONE }],
      });
    return phone;
  }
  const name = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 200)
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid name', {
      fields: [
        {
          field: 'value',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { min: 2, max: 200 },
        },
      ],
    });
  return name;
}

function invalidValue(field: string, message: string) {
  return appError.badRequest(ErrorCode.VALIDATION_FAILED, message, {
    fields: [{ field, code: FieldErrorCode.INVALID_VALUE }],
  });
}
