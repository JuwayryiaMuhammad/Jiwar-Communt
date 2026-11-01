import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { AccountDeputy } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../audit/audit.service';
import type { AppClsStore } from '../common/cls/app-cls';
import { RequestContext } from '../common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../common/errors';
import { invalid } from '../common/localized';
import { newId } from '../common/uuid';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { Notifier } from '../notifications/notifier';
import { SweepRunner } from '../sweep/sweep-runner';
import { ACCESS_CATALOG, type AccessCatalog } from './access-catalog';
import { isDerived } from './derived-grants';
import { PermissionsService } from './permissions.service';

export const DEPUTIES_SWEEP = 'deputies.expiry';
/** At most 30 days (ADR 0073). */
export const MAX_DEPUTY_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Never delegated (ADR 0073): money, the board's matters, appeals, the
 * roles, and deputies themselves (no deputy of a deputy).
 */
export function delegable(permission: string): boolean {
  return (
    !permission.startsWith('finance.') &&
    !permission.startsWith('governance.') &&
    permission !== 'appeals.decide' &&
    permission !== 'roles.manage' &&
    permission !== 'deputies.manage' &&
    !isDerived(permission)
  );
}

export type DeputyEndReason = 'ended' | 'expired' | 'account_left';

export interface DeputyRead {
  id: string;
  principalAccountId: string;
  deputyAccountId: string;
  permissions: string[];
  startsAt: Date;
  endsAt: Date;
  endedAt: Date | null;
  endReason: DeputyEndReason | null;
  /** Whether it is in force now. */
  live: boolean;
  /** The caller's side of it. */
  role: 'principal' | 'deputy';
}

/**
 * A deputy (ADR 0073, amending ADR 0010's one role per account): a manager
 * (`deputies.manage`) names another active staff or manager account to
 * decide in their place for at most 30 days, with permissions out of their
 * own role, never finance, governance, appeals, the roles or deputies. The
 * deputy gains them and the principal loses them while it runs
 * (PermissionsGuard); every action taken through one is audited on the
 * principal's behalf. One live deputy per principal, one live deputyship
 * per deputy, under both accounts' locks; ended once, by either of them,
 * or by the sweep when its time ran out or one of them left.
 */
@Injectable()
export class DeputiesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly cls: ClsService<AppClsStore>,
    private readonly permissions: PermissionsService,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly sweep: SweepRunner,
    @Inject(ACCESS_CATALOG) private readonly catalog: AccessCatalog,
  ) {}

  onModuleInit(): void {
    this.sweep.register(DEPUTIES_SWEEP, (now) => this.endDue(now), {
      intervalMs: 5 * 60_000,
    });
  }

  async appoint(input: {
    deputyAccountId: string;
    permissions: string[];
    endsAt: Date;
  }): Promise<DeputyRead> {
    const me = this.ctx.accountId;
    // The caller's own role: never what a deputyship gave them.
    const own = await this.permissions.forRole(
      this.ctx.tenantId,
      this.cls.get('roleId'),
      this.cls.get('permissionsVersion'),
      this.ctx.accountType,
    );
    const away = new Set(this.cls.get('delegation')?.away ?? []);
    const fields: FieldError[] = [];
    const seen = new Set<string>();
    input.permissions.forEach((p, i) => {
      if (seen.has(p))
        fields.push({
          field: `permissions[${i}]`,
          code: FieldErrorCode.DUPLICATE_VALUE,
        });
      seen.add(p);
      if (!own.has(p) || away.has(p) || !delegable(p))
        fields.push({
          field: `permissions[${i}]`,
          code: FieldErrorCode.INVALID_VALUE,
          params: { permission: p },
        });
    });
    if (input.deputyAccountId === me)
      fields.push({
        field: 'deputyAccountId',
        code: FieldErrorCode.INVALID_VALUE,
      });
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lockAccounts(tx, [me, input.deputyAccountId]);
      const now = await clock(tx);
      if (
        input.endsAt <= now ||
        input.endsAt.getTime() > now.getTime() + MAX_DEPUTY_DAYS * DAY_MS
      )
        throw invalid([
          {
            field: 'endsAt',
            code: FieldErrorCode.INVALID_VALUE,
            params: { maxDays: MAX_DEPUTY_DAYS },
          },
        ]);
      const deputy = await tx.account.findUnique({
        where: { id: input.deputyAccountId },
        select: { status: true, type: true },
      });
      if (
        !deputy ||
        deputy.status !== 'active' ||
        (deputy.type !== 'staff' && deputy.type !== 'manager')
      )
        throw invalid([
          { field: 'deputyAccountId', code: FieldErrorCode.INVALID_VALUE },
        ]);
      const kindless = input.permissions.findIndex(
        (p) => !this.catalog.permissions[p]?.kinds.includes(deputy.type),
      );
      if (kindless >= 0)
        throw invalid([
          {
            field: `permissions[${kindless}]`,
            code: FieldErrorCode.INVALID_VALUE,
            params: { permission: input.permissions[kindless] },
          },
        ]);
      // What ran out but the sweep has not ended yet does not count.
      await this.endWhere(tx, now, 'expired', {
        endsAt: { lte: now },
        OR: [
          { principalAccountId: { in: [me, input.deputyAccountId] } },
          { deputyAccountId: { in: [me, input.deputyAccountId] } },
        ],
      });
      const live = await tx.accountDeputy.findMany({
        where: {
          endedAt: null,
          OR: [
            { principalAccountId: me },
            { deputyAccountId: input.deputyAccountId },
          ],
        },
      });
      if (live.some((d) => d.principalAccountId === me))
        throw appError.conflict(
          ErrorCode.DEPUTY_ALREADY_SET,
          'You have a deputy already: end it first',
        );
      if (live.length)
        throw appError.conflict(
          ErrorCode.DEPUTY_BUSY,
          'The account is someone’s deputy already',
        );
      const row = await tx.accountDeputy.create({
        data: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          principalAccountId: me,
          deputyAccountId: input.deputyAccountId,
          permissions: [...input.permissions].sort(),
          startsAt: now,
          endsAt: input.endsAt,
          createdByAccountId: me,
        },
      });
      await this.syncFlags(tx, [me, input.deputyAccountId]);
      await this.audit.record(tx, {
        action: 'deputy.appointed',
        targetId: row.id,
        metadata: {
          deputyAccountId: row.deputyAccountId,
          permissions: row.permissions,
          endsAt: row.endsAt.toISOString(),
        },
      });
      await this.notifier.notify(tx, [row.deputyAccountId], {
        kind: 'deputy.appointed',
        params: { permissions: row.permissions.length },
        targetId: row.id,
      });
      return read(row, me, now);
    });
  }

  /** By either of its two accounts, once. */
  end(id: string): Promise<DeputyRead> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.accountDeputy.findUnique({ where: { id } });
      if (
        !found ||
        (found.principalAccountId !== me && found.deputyAccountId !== me)
      )
        throw notFound();
      await this.lockAccounts(tx, [
        found.principalAccountId,
        found.deputyAccountId,
      ]);
      await tx.$queryRaw`
        SELECT id FROM account_deputies WHERE id = ${id}::uuid FOR UPDATE`;
      const row = await tx.accountDeputy.findUniqueOrThrow({ where: { id } });
      if (row.endedAt)
        throw appError.conflict(ErrorCode.DEPUTY_ENDED, 'It ended already', {
          params: { reason: row.endReason! },
        });
      const now = await clock(tx);
      const ended = await tx.accountDeputy.update({
        where: { id },
        data: { endedAt: now, endReason: 'ended', endedByAccountId: me },
      });
      await this.syncFlags(tx, [row.principalAccountId, row.deputyAccountId]);
      await this.audit.record(tx, {
        action: 'deputy.ended',
        targetId: id,
        metadata: { reason: 'ended' },
      });
      const other =
        me === row.principalAccountId
          ? row.deputyAccountId
          : row.principalAccountId;
      await this.notifier.notify(tx, [other], {
        kind: 'deputy.ended',
        params: { reason: 'ended' },
        targetId: id,
      });
      return read(ended, me, now);
    });
  }

  /** The caller's deputyships, either side, the live first then the latest 20. */
  mine(): Promise<DeputyRead[]> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await clock(tx);
      const rows = await tx.accountDeputy.findMany({
        where: {
          OR: [{ principalAccountId: me }, { deputyAccountId: me }],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
      });
      return rows
        .map((r) => read(r, me, now))
        .sort((a, b) => Number(b.live) - Number(a.live));
    });
  }

  /**
   * The sweep: a deputyship whose time ran out ends as `expired`; one whose
   * principal or deputy is no longer active, as `account_left`. Both are
   * told.
   */
  private endDue(now: Date): Promise<number> {
    return this.sweep.forEachTenant(async (tx) => {
      const left = await tx.accountDeputy.findMany({
        where: {
          endedAt: null,
          endsAt: { gt: now },
        },
        select: { id: true, principalAccountId: true, deputyAccountId: true },
      });
      const inactive = new Set(
        (
          await tx.account.findMany({
            where: {
              id: {
                in: left.flatMap((d) => [
                  d.principalAccountId,
                  d.deputyAccountId,
                ]),
              },
              status: { not: 'active' },
            },
            select: { id: true },
          })
        ).map((a) => a.id),
      );
      const gone = left
        .filter(
          (d) =>
            inactive.has(d.principalAccountId) ||
            inactive.has(d.deputyAccountId),
        )
        .map((d) => d.id);
      return (
        (await this.endWhere(tx, now, 'expired', { endsAt: { lte: now } })) +
        (gone.length
          ? await this.endWhere(tx, now, 'account_left', { id: { in: gone } })
          : 0)
      );
    });
  }

  /** Ends the live rows matching `where`, each under its own lock, once. */
  private async endWhere(
    tx: TenantTxClient,
    now: Date,
    reason: Exclude<DeputyEndReason, 'ended'>,
    where: object,
  ): Promise<number> {
    const due = await tx.accountDeputy.findMany({
      where: { AND: [{ endedAt: null }, where] },
      select: { id: true, principalAccountId: true, deputyAccountId: true },
      orderBy: { id: 'asc' },
    });
    let n = 0;
    for (const { id, principalAccountId, deputyAccountId } of due) {
      // The accounts first, as an appointment and an end take them.
      await this.lockAccounts(tx, [principalAccountId, deputyAccountId]);
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM account_deputies
         WHERE id = ${id}::uuid AND ended_at IS NULL FOR UPDATE`;
      if (!row) continue;
      const ended = await tx.accountDeputy.update({
        where: { id },
        data: { endedAt: now, endReason: reason },
      });
      await this.syncFlags(tx, [
        ended.principalAccountId,
        ended.deputyAccountId,
      ]);
      await this.audit.record(tx, {
        action: 'deputy.ended',
        targetId: id,
        metadata: { reason },
      });
      await this.notifier.notify(
        tx,
        [ended.principalAccountId, ended.deputyAccountId],
        { kind: 'deputy.ended', params: { reason }, targetId: id },
      );
      n++;
    }
    return n;
  }

  /**
   * Each account's `deputy_until`: the latest end of its live deputyships,
   * either side, or null. The guard reads deputyships only while it is
   * ahead. Under the accounts' locks the caller holds.
   */
  private async syncFlags(tx: TenantTxClient, ids: string[]): Promise<void> {
    await tx.$executeRaw`
      UPDATE accounts a SET deputy_until = (
        SELECT max(d.ends_at) FROM account_deputies d
         WHERE d.ended_at IS NULL
           AND (d.principal_account_id = a.id OR d.deputy_account_id = a.id))
       WHERE a.id = ANY(${[...new Set(ids)]}::uuid[])`;
  }

  /** Both accounts, in id order: an appointment and an end never cross. */
  private async lockAccounts(tx: TenantTxClient, ids: string[]): Promise<void> {
    await tx.$queryRaw`
      SELECT id FROM accounts WHERE id = ANY(${[...new Set(ids)].sort()}::uuid[])
       ORDER BY id FOR UPDATE`;
  }
}

function read(r: AccountDeputy, me: string, now: Date): DeputyRead {
  return {
    id: r.id,
    principalAccountId: r.principalAccountId,
    deputyAccountId: r.deputyAccountId,
    permissions: r.permissions,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    endedAt: r.endedAt,
    endReason: r.endReason as DeputyEndReason | null,
    live: !r.endedAt && r.startsAt <= now && r.endsAt > now,
    role: r.principalAccountId === me ? 'principal' : 'deputy',
  };
}

const notFound = () =>
  appError.notFound(ErrorCode.DEPUTY_NOT_FOUND, 'No such deputyship');

async function clock(tx: TenantTxClient): Promise<Date> {
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`
    SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
  return now;
}
