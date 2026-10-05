import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  $Enums,
  Prisma,
  type OccupancyType,
  type ResidentRegistration,
  type UnitType,
} from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { AccountWriter } from '../../core/accounts/account-writer';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { SecurityEventsService } from '../../core/audit/security-events.service';
import {
  IdentifierHasher,
  normalizeEmail,
  normalizePhone,
} from '../../core/auth/identifier';
import { OtpService } from '../../core/auth/otp.service';
import type { AppClsStore } from '../../core/common/cls/app-cls';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { LOCALES, type Locale } from '../../core/common/i18n/locale';
import {
  checkIdentityDocument,
  type IdentityDocument,
  type IdentityDocumentInput,
} from '../../core/common/identity-document';
import {
  REASON_CODES,
  requireReasonCode,
  type ReasonInput,
} from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import type { Env } from '../../core/config/env.schema';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { Outbox } from '../../core/mail/outbox';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { COMMUNITY_NOTICES } from '../notices/community-notices';
import { lockUnits } from '../units/unit-lock';
import { ResidentsService } from './residents.service';

export const REGISTRATION_EXPIRY_SWEEP = 'residents.registration_expiry';

const LINK_PAGE = keysetCursor('createdAt');
/** The review queue: oldest first. */
const PENDING_PAGE = keysetCursor('createdAt', 'asc');

export interface CreatedRegistrationLink {
  id: string;
  /** Shown once; only its HMAC is stored. */
  token: string;
  createdAt: Date;
}

export interface RegistrationLinkView {
  id: string;
  createdAt: Date;
  revokedAt: Date | null;
}

/** What a registrant sends, at start and again (with the code) at completion. */
export interface RegistrationRequest extends IdentityDocumentInput {
  /** The compound's registration link token. */
  linkToken: string;
  fullName: string;
  /** As the registrant knows it; never looked up on their path. */
  unitCode: string;
  phone: string;
  /** Required: the code goes here (OTP is always by email). */
  email: string;
  occupancyType: OccupancyType;
  /** Owners only: false = they let the unit. */
  resides?: boolean;
  preferredLocale?: Locale;
  /** Optional activation data (02 §3). */
  unitType?: UnitType;
  areaSqm?: string | number;
  building?: string;
}

/** The one answer to every registrant, whatever they sent (ADR 0024). */
export const REGISTRATION_CODE_SENT = {
  code: 'REGISTRATION_CODE_SENT',
} as const;
export const REGISTRATION_RECEIVED = { code: 'REGISTRATION_RECEIVED' } as const;

export type RegistrationConflict =
  | 'unit_not_found'
  | 'unit_has_primary'
  | 'unit_has_residing_occupants'
  | 'phone_in_use'
  | 'email_in_use'
  | 'same_person_existing_account'
  | 'duplicate_pending_for_unit';

/** What the manager reviews; conflicts are computed at read time. */
export interface PendingRegistration {
  id: string;
  fullName: string;
  phone: string;
  email: string;
  unitCode: string;
  unitId: string | null;
  occupancyType: OccupancyType;
  resides: boolean;
  createdAt: Date;
  conflicts: RegistrationConflict[];
}

interface Valid {
  fullName: string;
  unitCode: string;
  phone: string;
  email: string;
  document: IdentityDocument;
  occupancyType: OccupancyType;
  resides: boolean;
  preferredLocale: Locale;
  unitType: UnitType | null;
  areaSqm: string | null;
  building: string | null;
}

/**
 * Resident self-registration (ADR 0024) — a REQUEST first, never an
 * account: name, unit code, phone, email and ID go to the compound; the
 * manager approves, and only approval creates the account and occupancy.
 *
 * The registrant's path gives the same body, status and work for every
 * input: the code goes to the email they typed whatever the link, unit or
 * phone; completion writes one pending row and one audit entry, and never
 * reads units, accounts or occupancies. Every difference (no such unit, a
 * primary already there, the phone taken, conflicting data) appears only
 * in the manager's review.
 *
 * This file may use runInTenantUnsafe (eslint.config.mjs): the compound
 * comes from the link before anyone is logged in, and the expiry sweep
 * walks every compound.
 */
@Injectable()
export class RegistrationService implements OnModuleInit {
  private readonly logger = new Logger(RegistrationService.name);
  private readonly pendingMs: number;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly globalDb: GlobalDbService,
    private readonly tenantTx: TenantTx,
    private readonly hasher: IdentifierHasher,
    private readonly otp: OtpService,
    private readonly rateLimit: RateLimitService,
    private readonly securityEvents: SecurityEventsService,
    private readonly audit: AuditService,
    private readonly cls: ClsService<AppClsStore>,
    private readonly ctx: RequestContext,
    private readonly writer: AccountWriter,
    private readonly outbox: Outbox,
    private readonly residents: ResidentsService,
    private readonly sweep: SweepRunner,
  ) {
    this.pendingMs =
      config.get('REGISTRATION_PENDING_DAYS', { infer: true }) * 86_400_000;
  }

  onModuleInit(): void {
    this.sweep.register(REGISTRATION_EXPIRY_SWEEP, (now) =>
      this.expireAbandoned(now),
    );
  }

  // --------------------------------------------------------------------------
  // Links (managers, `residents.manage`)
  // --------------------------------------------------------------------------

  /** A new link, returned once; older live links keep working until revoked. */
  async createLink(): Promise<CreatedRegistrationLink> {
    const token = randomBytes(32).toString('base64url');
    const tenantId = this.ctx.tenantId;
    const id = newId();
    const created = await this.tenantTx.withTenantTx(async (tx) => {
      const row = await this.globalDb.in(tx).registrationLink.create({
        data: {
          id,
          tokenHash: this.hasher.hashRegistrationLink(token),
          tenantId,
        },
      });
      await this.audit.record(tx, {
        action: 'registration_link.created',
        targetId: tenantId,
        metadata: { linkId: id },
      });
      return row;
    });
    return { id, token, createdAt: created.createdAt };
  }

  /**
   * The compound's links, newest first, live and revoked. The table is
   * global (the link is read before anyone is logged in), so the compound
   * is filtered explicitly.
   */
  async listLinks(
    q: { cursor?: string; limit?: number } = {},
  ): Promise<Page<RegistrationLinkView>> {
    const limit = clampLimit(q.limit);
    const rows = await this.globalDb.registrationLink.findMany({
      where: {
        AND: [
          { tenantId: this.ctx.tenantId },
          ...(LINK_PAGE.after(q.cursor) as Prisma.RegistrationLinkWhereInput[]),
        ],
      },
      select: { id: true, createdAt: true, revokedAt: true },
      orderBy: LINK_PAGE.orderBy,
      take: limit + 1,
    });
    return LINK_PAGE.toPage(rows, limit);
  }

  /** One live link stops at once; the others keep working. */
  async revokeLink(id: string): Promise<void> {
    const tenantId = this.ctx.tenantId;
    await this.tenantTx.withTenantTx(async (tx) => {
      const { count } = await this.globalDb.in(tx).registrationLink.updateMany({
        where: { id, tenantId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count === 0) {
        throw appError.notFound(
          ErrorCode.REGISTRATION_LINK_NOT_FOUND,
          'Registration link not found',
        );
      }
      await this.audit.record(tx, {
        action: 'registration_link.revoked',
        targetId: tenantId,
        metadata: { count, linkId: id },
      });
    });
  }

  /** Every live link stops at once: registration is off. */
  async revokeLinks(): Promise<number> {
    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const { count } = await this.globalDb.in(tx).registrationLink.updateMany({
        where: { tenantId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.record(tx, {
        action: 'registration_link.revoked',
        targetId: tenantId,
        metadata: { count },
      });
      return count;
    });
  }

  // --------------------------------------------------------------------------
  // The registrant (no account, no login)
  // --------------------------------------------------------------------------

  /**
   * Step 1. Shape errors only (the same for every compound); the code is
   * issued off the request path, to the typed email, for every input.
   */
  async start(
    input: RegistrationRequest,
    ip: string,
    locale: Locale,
  ): Promise<typeof REGISTRATION_CODE_SENT> {
    const valid = validate(input);
    await this.limit('start', ip, valid.email);
    const key = this.key(input.linkToken, valid);
    void this.otp
      .issueForRegistration(key, valid.email, locale)
      .catch((error: unknown) => {
        this.logger.error(
          `registration code failed: ${error instanceof Error ? error.name : 'Error'}`,
        );
      });
    return REGISTRATION_CODE_SENT;
  }

  /**
   * Step 2. The code proves the email. A valid link gets ONE upsert of the
   * pending request (by email) and one audit entry — no lookup of the unit,
   * the phone or any account on this path.
   */
  async complete(
    input: RegistrationRequest,
    code: string,
    ip: string,
  ): Promise<typeof REGISTRATION_RECEIVED> {
    const valid = validate(input);
    await this.limit('complete', ip, valid.email);
    const key = this.key(input.linkToken, valid);
    if (!(await this.otp.verifyRegistration(key, code ?? ''))) {
      await this.securityEvents.record('otp.verify_failed', {
        identifierHash: key,
        metadata: { purpose: 'registration' },
      });
      throw appError.unauthorized(
        ErrorCode.OTP_INVALID,
        'Invalid or expired code',
      );
    }
    const link = await this.globalDb.registrationLink.findUnique({
      where: { tokenHash: this.hasher.hashRegistrationLink(input.linkToken) },
      include: { tenant: { select: { status: true } } },
    });
    if (!link || link.revokedAt || link.tenant.status !== 'active') {
      // The link is published (a QR at the gate): its validity says
      // nothing about any person or unit. Recorded, off the path.
      this.securityEvents.recordInBackground('registration.link_invalid', {
        metadata: { stage: 'complete' },
      });
      return REGISTRATION_RECEIVED;
    }
    await this.cls.run({ ifNested: 'inherit' }, () => {
      this.cls.set('auditActor', { type: 'system', id: null });
      return this.tenantTx.runInTenantUnsafe(link.tenantId, (tx) =>
        this.upsert(tx, link.tenantId, valid),
      );
    });
    return REGISTRATION_RECEIVED;
  }

  // --------------------------------------------------------------------------
  // The manager (`residents.manage`)
  // --------------------------------------------------------------------------

  /** Pending requests, oldest first, a page at a time, each with its conflicts as of now. */
  async pending(
    q: { cursor?: string; limit?: number } = {},
  ): Promise<Page<PendingRegistration>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.residentRegistration.findMany({
        where: {
          AND: [
            { status: 'pending' },
            ...(PENDING_PAGE.after(
              q.cursor,
            ) as Prisma.ResidentRegistrationWhereInput[]),
          ],
        },
        orderBy: PENDING_PAGE.orderBy,
        take: limit + 1,
      });
      const page = PENDING_PAGE.toPage(rows, limit);
      const out: PendingRegistration[] = [];
      for (const r of page.items) {
        const { unitId, conflicts } = await this.conflicts(tx, r);
        out.push({
          id: r.id,
          fullName: r.fullName!,
          phone: r.phone!,
          email: r.email!,
          unitCode: r.unitCode,
          unitId,
          occupancyType: r.occupancyType,
          resides: r.resides,
          createdAt: r.createdAt,
          conflicts,
        });
      }
      return { items: out, nextCursor: page.nextCursor };
    });
  }

  /**
   * Approve: the account and the occupancy are created now, re-checked
   * under the unit lock. `unitId` corrects a mistyped unit;
   * `linkToExistingAccount` adds the unit to the same person's existing
   * resident account (same phone AND email). Any other clash is
   * REGISTRATION_CONFLICT with the list — never guessed.
   */
  async approve(
    id: string,
    options: { unitId?: string; linkToExistingAccount?: boolean } = {},
  ): Promise<{ accountId: string; occupancyId: string }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const reg = await this.lockedPending(tx, id);
      const unit = options.unitId
        ? await tx.unit.findUnique({ where: { id: options.unitId } })
        : await tx.unit.findFirst({ where: { code: reg.unitCode } });
      if (!unit) throw conflict(['unit_not_found']);
      await lockUnits(tx, [unit.id]);
      const same = await tx.account.findFirst({
        where: { type: 'resident', phone: reg.phone!, email: reg.email! },
        select: { id: true },
      });
      const clash = await tx.account.findMany({
        where: {
          type: 'resident',
          OR: [{ phone: reg.phone! }, { email: reg.email! }],
          ...(same ? { id: { not: same.id } } : {}),
        },
        select: { phone: true, email: true },
      });
      if (clash.length) {
        throw conflict([
          ...(clash.some((a) => a.phone === reg.phone)
            ? (['phone_in_use'] as const)
            : []),
          ...(clash.some((a) => a.email === reg.email)
            ? (['email_in_use'] as const)
            : []),
        ]);
      }
      if (same && !options.linkToExistingAccount) {
        throw conflict(['same_person_existing_account']);
      }
      const accountId =
        same?.id ??
        (
          await this.writer.create(tx, reg.tenantId, {
            type: 'resident',
            fullName: reg.fullName!,
            phone: reg.phone!,
            email: reg.email!,
            idDocumentType: reg.idDocumentType!,
            idDocumentNumber: reg.idDocumentNumber!,
            nationality: reg.nationality!,
            birthDate: reg.birthDate!,
            preferredLocale: reg.preferredLocale,
          })
        ).id;
      const occupancy = await this.residents.occupyIn(tx, {
        accountId,
        unitId: unit.id,
        occupancyType: reg.occupancyType,
        resides: reg.resides,
      });
      const applied = await this.applyUnitDetails(tx, unit.id, reg);
      await this.tellRegistrant(
        tx,
        reg,
        COMMUNITY_NOTICES.registrationApproved,
        {
          recipientAccountId: accountId,
        },
      );
      await this.decide(tx, reg, 'approved', {
        approvedAccountId: accountId,
        approvedOccupancyId: occupancy.id,
      });
      await this.audit.record(tx, {
        action: 'resident.registration_approved',
        targetId: reg.id,
        changes: diffChanges(
          { status: 'pending' },
          { status: 'approved' },
          'resident.registration_approved',
        ),
        metadata: {
          unitId: unit.id,
          accountId,
          occupancyId: occupancy.id,
          linkedExisting: !!same,
          unitDetailsApplied: applied,
        },
      });
      return { accountId, occupancyId: occupancy.id };
    });
  }

  /**
   * Reject with a reason. The registrant is told the reason text the
   * manager wrote — never which conflict the review showed.
   */
  async reject(id: string, reasonInput: ReasonInput): Promise<void> {
    const reason = requireReasonCode(
      reasonInput,
      REASON_CODES.registrationReject,
    );
    await this.tenantTx.withTenantTx(async (tx) => {
      const reg = await this.lockedPending(tx, id);
      await this.tellRegistrant(
        tx,
        reg,
        COMMUNITY_NOTICES.registrationRejected,
        {
          reason: reason.text,
        },
      );
      await this.decide(tx, reg, 'rejected', {
        decisionReasonCode: reason.code,
      });
      await this.audit.record(tx, {
        action: 'resident.registration_rejected',
        targetId: reg.id,
        changes: diffChanges(
          { status: 'pending' },
          { status: 'rejected' },
          'resident.registration_rejected',
        ),
        metadata: { reasonCode: reason.code },
      });
    });
  }

  /**
   * Sweep: a request nobody decided within REGISTRATION_PENDING_DAYS
   * expires; the registrant is told and its personal data is nulled — an
   * abandoned request never keeps an ID number forever.
   */
  async expireAbandoned(now: Date = new Date()): Promise<number> {
    const before = new Date(now.getTime() - this.pendingMs);
    const tenants = await this.globalDb.tenant.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    let expired = 0;
    for (const t of tenants) {
      expired += await this.cls.run({ ifNested: 'inherit' }, () => {
        this.cls.set('auditActor', { type: 'system', id: null });
        return this.tenantTx.runInTenantUnsafe(t.id, async (tx) => {
          const due = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM resident_registrations
             WHERE status = 'pending' AND created_at < ${before}
             ORDER BY created_at FOR UPDATE SKIP LOCKED`;
          for (const { id } of due) {
            const reg = await tx.residentRegistration.findUniqueOrThrow({
              where: { id },
            });
            await this.tellRegistrant(
              tx,
              reg,
              COMMUNITY_NOTICES.registrationExpired,
              {},
            );
            await this.decide(tx, reg, 'expired', {}, false);
            await this.audit.record(tx, {
              action: 'resident.registration_expired',
              targetId: id,
              changes: diffChanges(
                { status: 'pending' },
                { status: 'expired' },
                'resident.registration_expired',
              ),
            });
          }
          return due.length;
        });
      });
    }
    return expired;
  }

  // --------------------------------------------------------------------------

  private async upsert(tx: TenantTxClient, tenantId: string, v: Valid) {
    // One statement whatever exists: a new request, or the same email's
    // pending one replaced (the code proved the email, so only its owner can).
    const rows = await tx.$queryRaw<{ id: string; created: boolean }[]>`
      INSERT INTO resident_registrations
        (id, tenant_id, full_name, phone, email, id_document_type,
         id_document_number, nationality, birth_date, preferred_locale,
         unit_code, occupancy_type, resides, unit_type, area_sqm, building)
      VALUES (${newId()}::uuid, ${tenantId}::uuid, ${v.fullName}, ${v.phone}, ${v.email},
              ${v.document.idDocumentType}::id_document_type, ${v.document.idDocumentNumber},
              ${v.document.nationality}, ${v.document.birthDate}::date,
              ${v.preferredLocale}::locale, ${v.unitCode},
              ${v.occupancyType}::occupancy_type, ${v.resides},
              ${v.unitType}::unit_type, ${v.areaSqm}::numeric, ${v.building})
      ON CONFLICT (tenant_id, email) WHERE status = 'pending' DO UPDATE SET
        full_name = EXCLUDED.full_name, phone = EXCLUDED.phone,
        id_document_type = EXCLUDED.id_document_type,
        id_document_number = EXCLUDED.id_document_number,
        nationality = EXCLUDED.nationality, birth_date = EXCLUDED.birth_date,
        preferred_locale = EXCLUDED.preferred_locale,
        unit_code = EXCLUDED.unit_code, occupancy_type = EXCLUDED.occupancy_type,
        resides = EXCLUDED.resides, unit_type = EXCLUDED.unit_type,
        area_sqm = EXCLUDED.area_sqm, building = EXCLUDED.building,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id, (xmax = 0) AS created`;
    await this.audit.record(tx, {
      action: 'resident.self_registered',
      targetId: rows[0].id,
      metadata: { replaced: !rows[0].created, occupancyType: v.occupancyType },
    });
  }

  private async conflicts(
    tx: TenantTxClient,
    r: ResidentRegistration,
  ): Promise<{ unitId: string | null; conflicts: RegistrationConflict[] }> {
    const conflicts: RegistrationConflict[] = [];
    const unit = await tx.unit.findFirst({
      where: { code: r.unitCode },
      select: { id: true },
    });
    if (!unit) conflicts.push('unit_not_found');
    else {
      const primary = await tx.unitOccupancy.count({
        where: { unitId: unit.id, status: 'active', isPrimary: true },
      });
      const residing = await tx.unitOccupancy.count({
        where: { unitId: unit.id, status: 'active', resides: true },
      });
      if (primary) conflicts.push('unit_has_primary');
      if (residing) conflicts.push('unit_has_residing_occupants');
    }
    const accounts = await tx.account.findMany({
      where: {
        type: 'resident',
        OR: [{ phone: r.phone! }, { email: r.email! }],
      },
      select: { phone: true, email: true },
    });
    if (accounts.some((a) => a.phone === r.phone && a.email === r.email)) {
      conflicts.push('same_person_existing_account');
    }
    if (accounts.some((a) => a.phone === r.phone && a.email !== r.email)) {
      conflicts.push('phone_in_use');
    }
    if (accounts.some((a) => a.email === r.email && a.phone !== r.phone)) {
      conflicts.push('email_in_use');
    }
    const duplicates = await tx.residentRegistration.count({
      where: { status: 'pending', unitCode: r.unitCode, id: { not: r.id } },
    });
    if (duplicates) conflicts.push('duplicate_pending_for_unit');
    return { unitId: unit?.id ?? null, conflicts };
  }

  /** Activation data fills only what the unit does not know yet. */
  private async applyUnitDetails(
    tx: TenantTxClient,
    unitId: string,
    reg: ResidentRegistration,
  ): Promise<string[]> {
    const unit = await tx.unit.findUniqueOrThrow({ where: { id: unitId } });
    const data: Prisma.UnitUpdateInput = {};
    if (reg.unitType && !unit.unitType) data.unitType = reg.unitType;
    if (reg.areaSqm && !unit.areaSqm) data.areaSqm = reg.areaSqm;
    if (reg.building && !unit.building) data.building = reg.building;
    const fields = Object.keys(data);
    if (fields.length) await tx.unit.update({ where: { id: unitId }, data });
    return fields;
  }

  private async lockedPending(tx: TenantTxClient, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM resident_registrations
       WHERE id = ${id}::uuid AND status = 'pending' FOR UPDATE`;
    if (!rows.length) {
      throw appError.notFound(
        ErrorCode.REGISTRATION_NOT_FOUND,
        'Registration not found',
      );
    }
    return tx.residentRegistration.findUniqueOrThrow({ where: { id } });
  }

  /** The decision, and the request's personal data gone with it (CHECK). */
  private async decide(
    tx: TenantTxClient,
    reg: ResidentRegistration,
    status: 'approved' | 'rejected' | 'expired',
    extra: Partial<
      Pick<
        ResidentRegistration,
        'approvedAccountId' | 'approvedOccupancyId' | 'decisionReasonCode'
      >
    >,
    byAccount = true,
  ) {
    await tx.residentRegistration.update({
      where: { id: reg.id },
      data: {
        status,
        decidedAt: new Date(),
        decidedById: byAccount ? this.ctx.accountId : null,
        ...extra,
        fullName: null,
        phone: null,
        email: null,
        idDocumentType: null,
        idDocumentNumber: null,
        nationality: null,
        birthDate: null,
      },
    });
  }

  /** Queued before the request's email is nulled (same transaction). */
  private async tellRegistrant(
    tx: TenantTxClient,
    reg: ResidentRegistration,
    templateKey: string,
    extra: { reason?: string; recipientAccountId?: string },
  ) {
    const tenant = await this.globalDb.in(tx).tenant.findUniqueOrThrow({
      where: { id: reg.tenantId },
      select: { name: true },
    });
    await this.outbox.enqueue(tx, {
      tenantId: reg.tenantId,
      templateKey,
      locale: reg.preferredLocale,
      recipient: reg.email!,
      params: {
        compoundName: tenant.name,
        unitCode: reg.unitCode,
        ...(extra.reason ? { reason: extra.reason } : {}),
      },
      recipientAccountId: extra.recipientAccountId ?? null,
    });
  }

  private key(linkToken: string, v: Valid): string {
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          v.fullName,
          v.unitCode,
          v.phone,
          v.document.idDocumentType,
          v.document.idDocumentNumber,
          v.document.nationality,
          v.document.birthDate.toISOString().slice(0, 10),
          v.occupancyType,
          v.resides,
          v.unitType,
          v.areaSqm,
          v.building,
          v.preferredLocale,
        ]),
      )
      .digest('hex');
    return this.hasher.hashRegistrationRequest(
      this.hasher.hashRegistrationLink(linkToken ?? ''),
      v.email,
      digest,
    );
  }

  private async limit(stage: 'start' | 'complete', ip: string, email: string) {
    const window = this.config.get('OTP_RATE_LIMIT_WINDOW_SECONDS', {
      infer: true,
    });
    await this.rateLimit.consume(
      `register-${stage}:ip:${ip}`,
      this.config.get('OTP_RATE_LIMIT_PER_IP', { infer: true }),
      window,
    );
    await this.rateLimit.consume(
      `register-${stage}:email:${this.hasher.hashIdentifier({ type: 'email', value: email })}`,
      this.config.get('OTP_RATE_LIMIT_PER_IDENTIFIER', { infer: true }),
      window,
    );
  }
}

// ----------------------------------------------------------------------------

function validate(input: RegistrationRequest): Valid {
  const fields: FieldError[] = [];
  const fullName = (input.fullName ?? '').trim();
  if (fullName.length < 2 || fullName.length > 200) {
    fields.push({
      field: 'fullName',
      code: FieldErrorCode.INVALID_LENGTH,
      params: { min: 2, max: 200 },
    });
  }
  const unitCode = (input.unitCode ?? '').trim();
  if (!unitCode || unitCode.length > 50) {
    fields.push({ field: 'unitCode', code: FieldErrorCode.FIELD_REQUIRED });
  }
  if (!input.linkToken || typeof input.linkToken !== 'string') {
    fields.push({ field: 'linkToken', code: FieldErrorCode.FIELD_REQUIRED });
  }
  const phone = input.phone ? normalizePhone(input.phone) : null;
  if (!phone)
    fields.push({ field: 'phone', code: FieldErrorCode.INVALID_PHONE });
  const email = input.email?.trim() ? normalizeEmail(input.email) : null;
  if (!email)
    fields.push({ field: 'email', code: FieldErrorCode.INVALID_EMAIL });
  const checked = checkIdentityDocument(input);
  if ('fields' in checked) fields.push(...checked.fields);
  const occupancyTypes = Object.values($Enums.OccupancyType);
  if (!occupancyTypes.includes(input.occupancyType)) {
    fields.push({
      field: 'occupancyType',
      code: FieldErrorCode.INVALID_VALUE,
      params: { allowed: occupancyTypes },
    });
  }
  const resides =
    input.occupancyType === 'tenant' ? true : input.resides !== false;
  if (input.occupancyType === 'tenant' && input.resides === false) {
    fields.push({ field: 'resides', code: FieldErrorCode.INVALID_VALUE });
  }
  const unitTypes = Object.values($Enums.UnitType);
  if (input.unitType !== undefined && !unitTypes.includes(input.unitType)) {
    fields.push({
      field: 'unitType',
      code: FieldErrorCode.INVALID_VALUE,
      params: { allowed: unitTypes },
    });
  }
  let areaSqm: string | null = null;
  if (input.areaSqm !== undefined && input.areaSqm !== '') {
    const text = String(input.areaSqm).trim();
    if (!/^\d{1,6}(\.\d{1,2})?$/.test(text) || Number(text) <= 0) {
      fields.push({ field: 'areaSqm', code: FieldErrorCode.INVALID_NUMBER });
    } else areaSqm = text;
  }
  const building = input.building?.trim() || null;
  const preferredLocale = input.preferredLocale ?? 'ar';
  if (!(LOCALES as readonly string[]).includes(preferredLocale)) {
    fields.push({
      field: 'preferredLocale',
      code: FieldErrorCode.INVALID_VALUE,
    });
  }
  if (fields.length || !phone || !email || !('document' in checked)) {
    throw appError.badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Invalid registration',
      {
        fields,
      },
    );
  }
  return {
    fullName,
    unitCode,
    phone,
    email,
    document: checked.document,
    occupancyType: input.occupancyType,
    resides,
    preferredLocale,
    unitType: input.unitType ?? null,
    areaSqm,
    building,
  };
}

function conflict(conflicts: RegistrationConflict[]) {
  return appError.conflict(
    ErrorCode.REGISTRATION_CONFLICT,
    'The registration conflicts with existing data',
    { params: { conflicts } },
  );
}
