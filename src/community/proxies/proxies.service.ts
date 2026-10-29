import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { IdDocumentType, UnitProxy } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { IdentifierHasher } from '../../core/auth/identifier';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type ErrorParams,
} from '../../core/common/errors';
import { parseIdentityDocument } from '../../core/common/identity-document';
import { newId } from '../../core/common/uuid';
import { isRealDate } from '../../core/common/validation/local-date';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { PROXY_SCOPES, type ProxyScope } from '../capabilities/capabilities';
import { dbNow } from '../db-clock';
import { lockAccountShared } from '../residents/account-locks';
import { lockUnits } from '../units/unit-lock';

export const PROXY_EXPIRY_SWEEP = 'proxies.expiry';
/** Live (invited or active) proxies a unit holds at most. */
export const MAX_LIVE_PROXIES = 2;
/** An invite unanswered this long ends. */
export const PROXY_INVITE_DAYS = 7;
/** A proxy's end, a year at most after its appointment. */
const MAX_DAYS = 365;
const DAY_MS = 86_400_000;

/** Why a proxy ended (the CHECK's list). */
export type ProxyEndReason =
  | 'revoked'
  | 'expired'
  | 'invite_expired'
  | 'ownership_transferred'
  | 'household_ended'
  | 'appointer_left'
  | 'erased';

export interface NewProxy {
  fullName: string;
  email: string;
  phone: string;
  idDocumentType: IdDocumentType;
  idDocumentNumber: string;
  nationality?: string;
  birthDate?: string;
  scopes: string[];
  /** The last day, the compound's calendar. */
  endsOn: string;
}

export interface ProxyRead {
  id: string;
  unitId: string;
  status: 'invited' | 'active' | 'ended';
  scopes: ProxyScope[];
  /** Who: the invite's name while invited, the account's once accepted. */
  name: string | null;
  expiresAt: Date;
  inviteExpiresAt: Date;
  acceptedAt: Date | null;
  endedAt: Date | null;
  endReason: string | null;
  createdAt: Date;
}

/** A unit the caller is a proxy for, and whether it may act there now. */
export interface ProxyPlace {
  proxyId: string;
  unitId: string;
  unitCode: string;
  scopes: ProxyScope[];
  expiresAt: Date;
  /** The unit is closed or has no primary: the proxy acts. */
  usable: boolean;
}

const notFound = () =>
  appError.notFound(ErrorCode.PROXY_NOT_FOUND, 'Proxy not found');

/**
 * Unit proxies (ADR 0063). An active owner occupancy — never a delegate —
 * appoints an outside person for its unit, with scopes and an end (a year
 * at most): the owner gets a link once, the person opens it, receives a
 * code at the invited email and accepts into their own `proxy` account
 * (ProxyAcceptanceService). At most two live per unit, under the unit's
 * lock (after the caller's account). A proxy acts only while the unit is
 * closed or has no primary (the capabilities decide), with what its scopes
 * give and nothing else.
 *
 * It ends once: an owner revokes it; it expires (the sweep, and the
 * capabilities read the end against the clock meanwhile); the unit's
 * ownership is transferred or its household ends; the owner occupancy that
 * appointed it ends; either account is erased. An invite unanswered for
 * seven days ends too. The invite's personal data goes at acceptance or at
 * the end, and its link's pointer with it.
 */
@Injectable()
export class ProxiesService implements OnModuleInit {
  constructor(
    private readonly ctx: RequestContext,
    private readonly tenantTx: TenantTx,
    private readonly globalDb: GlobalDbService,
    private readonly hasher: IdentifierHasher,
    private readonly audit: AuditService,
    private readonly sweep: SweepRunner,
    private readonly settings: TenantSettingsService,
    private readonly lifecycle: AccountLifecycle,
  ) {}

  onModuleInit(): void {
    this.sweep.register(PROXY_EXPIRY_SWEEP, (now) => this.expire(now));
    // An erased proxy account's places end; an erased owner's occupancies
    // end on their own (endedOccupancy, below).
    this.lifecycle.onErasing(async (tx, account) => {
      const places = await tx.unitProxy.findMany({
        where: { accountId: account.id, status: 'active' },
      });
      for (const p of places) await this.end(tx, p, 'erased', null);
      return [];
    });
  }

  // --------------------------------------------------------------------------
  // The owners' side
  // --------------------------------------------------------------------------

  /** An owner appoints a proxy: the link's token, returned once. */
  create(
    unitId: string,
    input: NewProxy,
  ): Promise<{ proxy: ProxyRead; token: string }> {
    const scopes = [...new Set(input.scopes)];
    if (!scopes.length || scopes.some((s) => !isScope(s)))
      throw invalid('scopes', { allowed: [...PROXY_SCOPES] });
    const document = parseIdentityDocument(input);
    return this.tenantTx.withTenantTx(async (tx) => {
      await lockAccountShared(tx, this.ctx.accountId);
      await lockUnits(tx, [unitId]);
      const owner = await this.ownerOf(tx, unitId);
      // The input first (400), then the unit's room for one more (409).
      const now = await dbNow(tx);
      const expiresAt = await this.endOf(tx, input.endsOn, now);
      const live = await tx.unitProxy.count({
        where: { unitId, status: { in: ['invited', 'active'] } },
      });
      if (live >= MAX_LIVE_PROXIES)
        throw appError.conflict(
          ErrorCode.PROXY_LIMIT,
          'The unit has the most proxies it may',
          { params: { max: MAX_LIVE_PROXIES } },
        );
      const token = randomBytes(32).toString('base64url');
      const tokenHash = this.hasher.hashProxyInviteToken(token);
      const inviteExpiresAt = new Date(
        now.getTime() + PROXY_INVITE_DAYS * DAY_MS,
      );
      const row = await tx.unitProxy.create({
        data: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          unitId,
          appointedByOccupancyId: owner.id,
          createdBy: this.ctx.accountId,
          createdAt: now,
          scopes,
          expiresAt,
          fullName: input.fullName.trim(),
          email: input.email.trim().toLowerCase(),
          phone: input.phone.trim(),
          idDocumentType: document.idDocumentType,
          idDocumentNumber: document.idDocumentNumber,
          nationality: document.nationality,
          birthDate: document.birthDate,
          inviteExpiresAt,
        },
      });
      await this.globalDb.in(tx).proxyInviteToken.create({
        data: {
          tokenHash,
          tenantId: this.ctx.txTenantId,
          proxyId: row.id,
          expiresAt: inviteExpiresAt,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'unit_proxy.invited',
        targetId: row.id,
        metadata: { unitId, scopes, expiresAt: expiresAt.toISOString() },
      });
      return { proxy: await this.read(tx, row), token };
    });
  }

  /** The unit's proxies, for its active owners. */
  list(unitId: string): Promise<ProxyRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.ownerOf(tx, unitId, true);
      return this.ofUnit(tx, unitId);
    });
  }

  /** Any active owner of the unit ends one of its proxies. */
  revoke(unitId: string, id: string): Promise<ProxyRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await lockAccountShared(tx, this.ctx.accountId);
      await lockUnits(tx, [unitId]);
      await this.ownerOf(tx, unitId);
      const row = await tx.unitProxy.findFirst({
        where: { id, unitId, status: { in: ['invited', 'active'] } },
      });
      if (!row) throw notFound();
      const ended = await this.end(tx, row, 'revoked', this.ctx.accountId);
      return this.read(tx, ended);
    });
  }

  // --------------------------------------------------------------------------
  // The management (`residents.manage`, read only) and the proxy itself
  // --------------------------------------------------------------------------

  staffList(unitId: string): Promise<ProxyRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const unit = await tx.unit.findUnique({
        where: { id: unitId },
        select: { id: true },
      });
      if (!unit)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      return this.ofUnit(tx, unitId);
    });
  }

  /** The units the caller is an active proxy for. */
  mine(): Promise<ProxyPlace[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const rows = await tx.unitProxy.findMany({
        where: {
          accountId: this.ctx.accountId,
          status: 'active',
          expiresAt: { gt: now },
        },
        include: { unit: { select: { code: true, closedSince: true } } },
        orderBy: { acceptedAt: 'asc' },
      });
      const out: ProxyPlace[] = [];
      for (const r of rows) {
        const primary = await tx.unitOccupancy.findFirst({
          where: { unitId: r.unitId, status: 'active', isPrimary: true },
          select: { id: true },
        });
        out.push({
          proxyId: r.id,
          unitId: r.unitId,
          unitCode: r.unit.code,
          scopes: r.scopes as ProxyScope[],
          expiresAt: r.expiresAt,
          usable: r.unit.closedSince !== null || primary === null,
        });
      }
      return out;
    });
  }

  // --------------------------------------------------------------------------
  // Hooks from the household's life, in its transaction and unit lock
  // --------------------------------------------------------------------------

  /** Every live proxy of the unit ends (its household or ownership ended). */
  async endForUnit(
    tx: TenantTxClient,
    unitId: string,
    reason: 'household_ended' | 'ownership_transferred',
  ): Promise<number> {
    const rows = await tx.unitProxy.findMany({
      where: { unitId, status: { in: ['invited', 'active'] } },
    });
    for (const r of rows) await this.end(tx, r, reason, null);
    return rows.length;
  }

  /** The owner occupancy that appointed them ended: so do they. */
  async endedOccupancy(tx: TenantTxClient, occupancyId: string) {
    const rows = await tx.unitProxy.findMany({
      where: {
        appointedByOccupancyId: occupancyId,
        status: { in: ['invited', 'active'] },
      },
    });
    for (const r of rows) await this.end(tx, r, 'appointer_left', null);
  }

  /** Ends one live proxy: the invite's details and its link go with it. */
  async end(
    tx: TenantTxClient,
    row: UnitProxy,
    reason: ProxyEndReason,
    by: string | null,
  ): Promise<UnitProxy> {
    const ended = await tx.unitProxy.update({
      where: { id: row.id },
      data: {
        status: 'ended',
        endedAt: await dbNow(tx),
        endReason: reason,
        endedBy: by,
        ...personalGone,
      },
    });
    await this.globalDb
      .in(tx)
      .proxyInviteToken.deleteMany({ where: { proxyId: row.id } });
    await this.audit.record(tx, {
      action: reason === 'revoked' ? 'unit_proxy.revoked' : 'unit_proxy.ended',
      targetId: row.id,
      metadata: {
        unitId: row.unitId,
        wasActive: row.status === 'active',
        ...(reason === 'revoked' ? {} : { reasonCode: reason }),
      },
    });
    return ended;
  }

  // --------------------------------------------------------------------------

  /** Invites unanswered past their 7 days, proxies past their end. */
  private expire(now: Date): Promise<number> {
    return this.sweep.forEachTenant(async (tx) => {
      const due = await tx.unitProxy.findMany({
        where: {
          OR: [
            { status: 'invited', inviteExpiresAt: { lte: now } },
            { status: 'active', expiresAt: { lte: now } },
          ],
        },
        take: 500,
      });
      for (const r of due) {
        await lockUnits(tx, [r.unitId]);
        const fresh = await tx.unitProxy.findUniqueOrThrow({
          where: { id: r.id },
        });
        if (fresh.status === 'ended') continue;
        await this.end(
          tx,
          fresh,
          fresh.status === 'invited' ? 'invite_expired' : 'expired',
          null,
        );
      }
      return due.length;
    });
  }

  /** The caller's active owner occupancy of the unit, or the refusal. */
  private async ownerOf(tx: TenantTxClient, unitId: string, read = false) {
    const unit = await tx.unit.findUnique({
      where: { id: unitId },
      select: { id: true },
    });
    if (!unit)
      throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
    const owner = await tx.unitOccupancy.findFirst({
      where: {
        unitId,
        accountId: this.ctx.accountId,
        status: 'active',
        occupancyType: 'owner',
      },
      select: { id: true },
    });
    if (!owner)
      throw appError.forbidden(
        ErrorCode.PROXY_NOT_ALLOWED,
        read
          ? 'Only the unit’s owners see its proxies'
          : 'Only an owner of the unit appoints or revokes a proxy',
      );
    return owner;
  }

  private async ofUnit(tx: TenantTxClient, unitId: string) {
    const rows = await tx.unitProxy.findMany({
      where: { unitId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    // One query at a time on the transaction's connection.
    const out: ProxyRead[] = [];
    for (const r of rows) out.push(await this.read(tx, r));
    return out;
  }

  private async read(tx: TenantTxClient, r: UnitProxy): Promise<ProxyRead> {
    const account = r.accountId
      ? await tx.account.findUnique({
          where: { id: r.accountId },
          select: { fullName: true },
        })
      : null;
    return {
      id: r.id,
      unitId: r.unitId,
      status: r.status as ProxyRead['status'],
      scopes: r.scopes as ProxyScope[],
      name: r.fullName ?? account?.fullName ?? null,
      expiresAt: r.expiresAt,
      inviteExpiresAt: r.inviteExpiresAt,
      acceptedAt: r.acceptedAt,
      endedAt: r.endedAt,
      endReason: r.endReason,
      createdAt: r.createdAt,
    };
  }

  /** The end of the last day, on the compound's calendar; a year at most. */
  private async endOf(
    tx: TenantTxClient,
    day: string,
    now: Date,
  ): Promise<Date> {
    // Date.parse takes 2026-02-30, and `::date` below would not.
    if (!isRealDate(day)) throw invalid('endsOn', { maxDaysAhead: MAX_DAYS });
    const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
    const [{ end }] = await tx.$queryRaw<{ end: Date }[]>`
      SELECT ((${day}::date + 1)::timestamp AT TIME ZONE ${timezone}) AS "end"`;
    if (
      end.getTime() <= now.getTime() ||
      end.getTime() > now.getTime() + MAX_DAYS * DAY_MS
    )
      throw invalid('endsOn', { maxDaysAhead: MAX_DAYS });
    return end;
  }
}

const personalGone = {
  fullName: null,
  email: null,
  phone: null,
  idDocumentType: null,
  idDocumentNumber: null,
  nationality: null,
  birthDate: null,
};

function isScope(s: string): s is ProxyScope {
  return (PROXY_SCOPES as readonly string[]).includes(s);
}

function invalid(field: string, params: ErrorParams) {
  return appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid proxy', {
    fields: [{ field, code: FieldErrorCode.INVALID_VALUE, params }],
  });
}

export { personalGone as PROXY_PERSONAL_GONE };
