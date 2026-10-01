import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type VisitorPass, type VisitorPassKind } from '@prisma/client';
import { CommunityGatePort, type GateSchedule } from '../../community';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { AccessTokens } from '../../core/auth/access-token';
import { IdentifierHasher, normalizePhone } from '../../core/auth/identifier';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import type { Env } from '../../core/config/env.schema';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { requestHash } from '../../core/idempotency/idempotency-key';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';

export interface NewPass {
  kind: VisitorPassKind;
  partySize: number;
  validFrom: Date;
  validUntil: Date;
  schedule?: GateSchedule;
  visitorName?: string;
  visitorPhone?: string;
}

/**
 * A pass as its host sees it right after creating it (or reissuing its
 * link): the code, the link and the QR payload, once (ADR 0030).
 */
export interface IssuedPass {
  id: string;
  /** Null only on a replay of a pass that is no longer active. */
  code: string | null;
  /** `<PUBLIC_APP_URL>/v#<token>`: the token travels in the fragment. */
  link: string | null;
  /** `JWR1.<token>`, for the visitor's QR. */
  qrPayload: string | null;
  kind: VisitorPassKind;
  partySize: number;
  validFrom: Date;
  validUntil: Date;
  schedule: GateSchedule | null;
  status: PassStatus;
}

export type PassStatus = 'active' | 'used' | 'cancelled' | 'expired';

export interface PassListItem {
  id: string;
  kind: VisitorPassKind;
  partySize: number;
  validFrom: Date;
  validUntil: Date;
  schedule: GateSchedule | null;
  status: PassStatus;
  mine: boolean;
  /** The caller's own passes only. */
  visitorName: string | null;
  createdAt: Date;
}

/** A one-time pass covers one visit, a recurring one a season at most. */
export const PASS_WINDOW_DAYS = { one_time: 7, recurring: 180 } as const;
/** How long a visitor's name and phone outlive the pass (ADR 0028). */
export const VISITOR_DATA_DAYS = 30;
const DAY = 86_400_000;
const PAGE = keysetCursor('createdAt');
/** The idempotency resource of `reissue-link`: replayed, never stored. */
export const PASS_LINK_RESOURCE = 'visitor_pass_link';

/** A pass's secret, issued once: the token never touches the database. */
interface PassToken {
  token: string;
  code: string;
  codeHash: string;
  qrHash: string;
}

export const passNotFound = () =>
  appError.notFound(ErrorCode.VISITOR_PASS_NOT_FOUND, 'Visitor pass not found');

/**
 * Visitor passes (ADR 0028). A host who may invite visitors on a unit
 * (capabilities.visitorsInvite) creates a pass and gets a 6-digit code,
 * shown once and stored only as an HMAC. One-time passes are used by their
 * first entry; recurring ones follow a weekly schedule in the compound's
 * time zone. A pass is valid only while its host still may invite on the
 * unit: the gate checks that at every use, and a host who is deactivated,
 * frozen or erased has their active passes cancelled.
 *
 * `Idempotency-Key` lives on the pass itself (never a stored body: the code
 * is a secret). A replay returns the same pass with a fresh code — the
 * first one dies (`visitor_pass.code_reissued`).
 *
 * Each code is derived from a random token (ADR 0030): the link the host
 * shares (`/v#<token>`) and the QR carry the token; the pass keeps the
 * code's and the token's HMACs, and a global pointer from the link's HMAC
 * lets the public page find the pass. A new code is always a new token, and
 * the old pointer goes in the same transaction.
 */
@Injectable()
export class VisitorPassesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly hasher: IdentifierHasher,
    private readonly community: CommunityGatePort,
    private readonly settings: TenantSettingsService,
    private readonly lifecycle: AccountLifecycle,
    private readonly tokens: AccessTokens,
    private readonly globalDb: GlobalDbService,
    private readonly idempotency: IdempotencyService,
    config: ConfigService<Env, true>,
  ) {
    this.appUrl = config.get('PUBLIC_APP_URL', { infer: true });
  }

  private readonly appUrl: string;

  onModuleInit(): void {
    this.idempotency.renderer(PASS_LINK_RESOURCE, (id) =>
      this.tenantTx.withTenantTx((tx) =>
        this.reissueIn(tx, id, 'idempotent_replay'),
      ),
    );
    const cancelHosted = async (
      tx: TenantTxClient,
      account: { id: string },
    ) => {
      const active = await tx.visitorPass.findMany({
        where: { hostAccountId: account.id, status: 'active' },
        select: { id: true },
      });
      for (const p of active) await this.close(tx, p.id, 'host_inactive');
    };
    this.lifecycle.onDeactivated(async (tx, account) => {
      await cancelHosted(tx, account);
      return [];
    });
    this.lifecycle.onFrozen((tx, account) => cancelHosted(tx, account));
    this.lifecycle.onErasing(async (tx, account) => {
      await cancelHosted(tx, account);
      return [];
    });
  }

  async create(
    unitId: string,
    input: NewPass,
    idempotencyKey?: string,
  ): Promise<IssuedPass> {
    const pass = this.validate(input);
    const hash = idempotencyKey
      ? requestHash('POST', '/units/:unitId/visitor-passes', { unitId }, input)
      : null;
    // A concurrent duplicate loses on the key's unique index; the second
    // attempt finds the winner and replays it. Two passes created at once
    // in the compound may derive the same code: the loser retries with a
    // new token.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.tenantTx.withTenantTx((tx) =>
          this.createIn(tx, unitId, pass, idempotencyKey, hash),
        );
      } catch (error) {
        if (
          attempt === 0 &&
          ((idempotencyKey && isUniqueOn(error, 'idempotency')) ||
            isUniqueOn(error, 'visitor_passes_active_code'))
        )
          continue;
        throw error;
      }
    }
  }

  private async createIn(
    tx: TenantTxClient,
    unitId: string,
    input: NewPass,
    key: string | undefined,
    hash: string | null,
  ): Promise<IssuedPass> {
    const tenantId = this.ctx.tenantId;
    const hostAccountId = this.ctx.accountId;
    if (key) {
      const existing = await tx.visitorPass.findUnique({
        where: {
          tenantId_hostAccountId_idempotencyKey: {
            tenantId,
            hostAccountId,
            idempotencyKey: key,
          },
        },
      });
      if (existing) return this.replay(tx, existing, hash!);
    }
    await this.requireInviter(tx, unitId);
    await this.community.lockUnit(tx, unitId);
    const settings = await this.settings.inTx(tx, tenantId);
    const now = new Date();
    const active = await tx.visitorPass.count({
      where: { unitId, status: 'active', validUntil: { gt: now } },
    });
    if (active >= settings.maxActiveVisitorPasses)
      throw appError.conflict(
        ErrorCode.VISITOR_PASS_LIMIT_REACHED,
        'This unit has as many active visitor passes as the compound allows',
        { params: { max: settings.maxActiveVisitorPasses } },
      );

    let detailsId: string | null = null;
    if (input.visitorName || input.visitorPhone) {
      detailsId = newId();
      await tx.visitorDetails.create({
        data: {
          id: detailsId,
          tenantId,
          fullName: input.visitorName ?? null,
          phone: input.visitorPhone ?? null,
          expiresAt: new Date(
            input.validUntil.getTime() + VISITOR_DATA_DAYS * DAY,
          ),
        },
      });
    }
    const secret = await this.freshToken(tx, tenantId);
    const id = newId();
    const created = await tx.visitorPass.create({
      data: {
        id,
        tenantId,
        unitId,
        hostAccountId,
        kind: input.kind,
        partySize: input.partySize,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
        schedule: input.schedule
          ? (input.schedule as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
        codeHash: secret.codeHash,
        qrTokenHash: secret.qrHash,
        visitorDetailsId: detailsId,
        idempotencyKey: key ?? null,
        requestHash: hash,
      },
    });
    await this.link(tx, created, secret);
    await this.audit.record(tx, {
      action: 'visitor_pass.created',
      targetId: id,
      metadata: {
        unitId,
        kind: input.kind,
        partySize: input.partySize,
      },
    });
    return this.issued(created, secret);
  }

  /** The same pass, a new code: the first one dies with the retry. */
  private async replay(
    tx: TenantTxClient,
    pass: VisitorPass,
    hash: string,
  ): Promise<IssuedPass> {
    if (pass.requestHash !== hash)
      throw appError.conflict(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        'This Idempotency-Key was used for a different request',
      );
    await this.lockPass(tx, pass.id);
    const fresh = await tx.visitorPass.findUniqueOrThrow({
      where: { id: pass.id },
    });
    if (passStatus(fresh) !== 'active') return this.issued(fresh, null);
    return this.rotate(tx, fresh, 'idempotent_replay');
  }

  /**
   * `POST /visitor-passes/:id/reissue-link` (ADR 0030): the host lost the
   * link. A new token — so a new link, QR and code — for the same pass; the
   * old ones are dead at commit. The host or the unit's primary, an active
   * pass only; anything else is "not found". `Idempotency-Key` is claimed
   * but no body is stored (it holds the secret): a replay reissues again.
   */
  async reissueLink(id: string): Promise<IssuedPass> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const pass = await tx.visitorPass.findUnique({ where: { id } });
      if (!pass || !(await this.mayManage(tx, pass))) throw passNotFound();
      await this.idempotency.claim(tx, { type: PASS_LINK_RESOURCE, id });
      return this.reissueIn(tx, id, 'link_reissued');
    });
  }

  /** Under the pass lock: an active pass the caller may manage, a new token. */
  private async reissueIn(
    tx: TenantTxClient,
    id: string,
    reason: 'link_reissued' | 'idempotent_replay',
  ): Promise<IssuedPass> {
    await this.lockPass(tx, id);
    const pass = await tx.visitorPass.findUnique({ where: { id } });
    if (!pass || !(await this.mayManage(tx, pass))) throw passNotFound();
    if (passStatus(pass) !== 'active') {
      // A replay reports what became of the pass; a first call is refused.
      if (reason === 'idempotent_replay') return this.issued(pass, null);
      throw passNotFound();
    }
    return this.rotate(tx, pass, reason);
  }

  /** A new token for an active pass: code, QR and link, old ones dead. */
  private async rotate(
    tx: TenantTxClient,
    pass: VisitorPass,
    reason: 'link_reissued' | 'idempotent_replay',
  ): Promise<IssuedPass> {
    const secret = await this.freshToken(tx, pass.tenantId);
    const updated = await tx.visitorPass.update({
      where: { id: pass.id },
      data: { codeHash: secret.codeHash, qrTokenHash: secret.qrHash },
    });
    await this.globalDb
      .in(tx)
      .visitorPassLink.deleteMany({ where: { passId: pass.id } });
    await this.link(tx, updated, secret);
    await this.audit.record(tx, {
      action: 'visitor_pass.code_reissued',
      targetId: pass.id,
      metadata: { reason },
    });
    return this.issued(updated, secret);
  }

  /** The public page's pointer, kept as long as the visitor's data (ADR 0030). */
  private async link(
    tx: TenantTxClient,
    pass: VisitorPass,
    secret: PassToken,
  ): Promise<void> {
    await this.globalDb.in(tx).visitorPassLink.create({
      data: {
        tokenHash: this.hasher.hashVisitorLink(secret.token),
        tenantId: pass.tenantId,
        passId: pass.id,
        expiresAt: new Date(
          pass.validUntil.getTime() + VISITOR_DATA_DAYS * DAY,
        ),
      },
    });
  }

  /** The row lock gate entries take on a pass (ADR 0028). */
  private async lockPass(tx: TenantTxClient, id: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM visitor_passes WHERE id = ${id}::uuid FOR UPDATE`;
  }

  /** The host while still placed on the unit, or the unit's primary. */
  private async mayManage(
    tx: TenantTxClient,
    pass: VisitorPass,
  ): Promise<boolean> {
    const me = this.ctx.accountId;
    if (
      pass.hostAccountId === me &&
      (await this.community.placeIn(tx, me, pass.unitId)) !== null
    )
      return true;
    return this.community.isPrimary(tx, pass.unitId, me);
  }

  /** The unit's passes: a host sees their own, the primary every one. */
  async listForUnit(
    unitId: string,
    q: { cursor?: string; limit?: number } = {},
  ): Promise<Page<PassListItem>> {
    const limit = clampLimit(q.limit);
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.requireInviter(tx, unitId);
      const all = await this.community.isPrimary(tx, unitId, me);
      const rows = await tx.visitorPass.findMany({
        where: {
          AND: [
            { unitId },
            ...(all ? [] : [{ hostAccountId: me }]),
            ...(PAGE.after(q.cursor) as Prisma.VisitorPassWhereInput[]),
          ],
        },
        include: { visitorDetails: { select: { fullName: true } } },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return {
        nextCursor: page.nextCursor,
        items: page.items.map((p) => {
          const mine = p.hostAccountId === me;
          return {
            id: p.id,
            kind: p.kind,
            partySize: p.partySize,
            validFrom: p.validFrom,
            validUntil: p.validUntil,
            schedule: (p.schedule as GateSchedule | null) ?? null,
            status: passStatus(p),
            mine,
            visitorName: mine ? (p.visitorDetails?.fullName ?? null) : null,
            createdAt: p.createdAt,
          };
        }),
      };
    });
  }

  /** The host, or the unit's primary. Anyone else: not found. */
  async cancel(id: string, reasonCode: string | undefined): Promise<void> {
    const code = checkCancelCode(reasonCode);
    const me = this.ctx.accountId;
    await this.tenantTx.withTenantTx(async (tx) => {
      const pass = await tx.visitorPass.findUnique({ where: { id } });
      if (!pass || !(await this.mayManage(tx, pass))) throw passNotFound();
      if (pass.status === 'cancelled') return;
      if (passStatus(pass) !== 'active')
        throw appError.conflict(
          ErrorCode.VISITOR_PASS_NOT_ACTIVE,
          'Only an active pass can be cancelled',
          { params: { status: passStatus(pass) } },
        );
      await this.close(tx, id, code, me);
    });
  }

  /**
   * Cancels an active pass in the caller's transaction, code and token with
   * it, audited `visitor_pass.cancelled` with the reason code (actor from
   * the context: the host, or `system`). A pass no longer active is left.
   */
  async close(
    tx: TenantTxClient,
    id: string,
    reasonCode: string,
    by: string | null = null,
  ): Promise<void> {
    const { count } = await tx.visitorPass.updateMany({
      where: { id, status: 'active' },
      data: {
        status: 'cancelled',
        codeHash: null,
        qrTokenHash: null,
        cancelledAt: new Date(),
        cancelledById: by,
        cancelReasonCode: reasonCode,
      },
    });
    if (!count) return;
    await this.audit.record(tx, {
      action: 'visitor_pass.cancelled',
      targetId: id,
      metadata: { reasonCode },
    });
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

  /**
   * A new token whose 6-digit code is free among the compound's active
   * passes (only active passes have a code). A taken code is a new token.
   */
  private async freshToken(
    tx: TenantTxClient,
    tenantId: string,
  ): Promise<PassToken> {
    const hashOf = (code: string) =>
      this.hasher.hashVisitorCode(tenantId, code);
    const t = await this.tokens.issue(
      tenantId,
      6,
      async (code) =>
        (await tx.visitorPass.count({ where: { codeHash: hashOf(code) } })) > 0,
    );
    return { ...t, codeHash: hashOf(t.code) };
  }

  private issued(p: VisitorPass, secret: PassToken | null): IssuedPass {
    return {
      id: p.id,
      code: secret?.code ?? null,
      link: secret ? `${this.appUrl}/v#${secret.token}` : null,
      qrPayload: secret ? this.tokens.qrPayload(secret.token) : null,
      kind: p.kind,
      partySize: p.partySize,
      validFrom: p.validFrom,
      validUntil: p.validUntil,
      schedule: (p.schedule as GateSchedule | null) ?? null,
      status: passStatus(p),
    };
  }

  private validate(input: NewPass): NewPass {
    const fields: FieldError[] = [];
    const now = Date.now();
    const from = input.validFrom.getTime();
    const until = input.validUntil.getTime();
    const maxDays = PASS_WINDOW_DAYS[input.kind];
    if (from < now - 5 * 60_000)
      fields.push({ field: 'validFrom', code: FieldErrorCode.INVALID_VALUE });
    if (until <= from || until - from > maxDays * DAY)
      fields.push({
        field: 'validUntil',
        code: FieldErrorCode.INVALID_VALUE,
        params: { maxDays },
      });
    let schedule: GateSchedule | undefined;
    if (input.kind === 'recurring') {
      if (!input.schedule)
        fields.push({ field: 'schedule', code: FieldErrorCode.FIELD_REQUIRED });
      else schedule = this.community.checkSchedule(input.schedule, fields);
    } else if (input.schedule) {
      fields.push({
        field: 'schedule',
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
    }
    let phone: string | undefined;
    if (input.visitorPhone !== undefined) {
      phone = normalizePhone(input.visitorPhone) ?? undefined;
      if (!phone)
        fields.push({
          field: 'visitorPhone',
          code: FieldErrorCode.INVALID_PHONE,
        });
    }
    if (fields.length)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid visitor pass',
        { fields },
      );
    return {
      ...input,
      schedule,
      visitorName: input.visitorName?.trim() || undefined,
      visitorPhone: phone,
    };
  }
}

/** What the host sees: past its end, an active pass is expired. */
export function passStatus(p: {
  status: VisitorPass['status'];
  validUntil: Date;
}): PassStatus {
  if (p.status === 'active' && p.validUntil.getTime() <= Date.now())
    return 'expired';
  return p.status;
}

function checkCancelCode(code: string | undefined): string {
  const allowed = REASON_CODES.visitorPassCancel as readonly string[];
  if (!code)
    throw appError.badRequest(
      ErrorCode.REASON_REQUIRED,
      'A reason is required',
      {
        fields: [{ field: 'reasonCode', code: FieldErrorCode.FIELD_REQUIRED }],
      },
    );
  if (!allowed.includes(code))
    throw appError.badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Unknown reason code',
      {
        fields: [
          {
            field: 'reasonCode',
            code: FieldErrorCode.INVALID_REASON_CODE,
            params: { allowed: [...allowed] },
          },
        ],
      },
    );
  return code;
}

function isUniqueOn(error: unknown, column: string): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  )
    return false;
  return JSON.stringify(error.meta ?? {}).includes(column);
}
