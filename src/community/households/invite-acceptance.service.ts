import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { AccountWriter } from '../../core/accounts/account-writer';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { SecurityEventsService } from '../../core/audit/security-events.service';
import { IdentifierHasher } from '../../core/auth/identifier';
import { OtpService } from '../../core/auth/otp.service';
import type { AppClsStore } from '../../core/common/cls/app-cls';
import { parseEgyptianNationalId } from '../../core/common/egyptian-national-id';
import { appError, ErrorCode } from '../../core/common/errors';
import type { Locale } from '../../core/common/i18n/locale';
import { newId } from '../../core/common/uuid';
import type { Env } from '../../core/config/env.schema';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { lockUnits } from '../units/unit-lock';
import { expireIfDue } from './households.service';
import type { AcceptedInvite } from './households.types';

/** The one answer to "send me the code", whatever the token is. */
export const INVITE_CODE_REQUESTED_MESSAGE =
  'If this invitation is valid, a code has been sent to the invited email.';

/**
 * Accepting a household invite (ADR 0016). The invitee has no account and no
 * tenant yet, so the invite is found through the global `invite_tokens` row
 * and read with runInTenantUnsafe in exactly that compound. This file is the
 * only one in src/community/ allowed to do that (ESLint; ADR 0005).
 *
 * 1. startAcceptance(token): a code goes to the invited email, and only to
 *    it. The response never says whether the token was valid.
 * 2. completeAcceptance(token, code): one transaction creates (or reuses) the
 *    `family` account, the membership (pending when the compound requires
 *    approval), marks the invite accepted and deletes its token. The member
 *    then logs in through the normal OTP login.
 */
@Injectable()
export class InviteAcceptanceService {
  private readonly logger = new Logger(InviteAcceptanceService.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly globalDb: GlobalDbService,
    private readonly tenantTx: TenantTx,
    private readonly hasher: IdentifierHasher,
    private readonly otp: OtpService,
    private readonly rateLimit: RateLimitService,
    private readonly securityEvents: SecurityEventsService,
    private readonly writer: AccountWriter,
    private readonly settings: TenantSettingsService,
    private readonly audit: AuditService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  /**
   * Rate-limited per IP and per token. The lookup and the email happen off
   * the request path, so neither status nor timing tells a valid token from
   * an invalid one.
   */
  async startAcceptance(
    token: string,
    ip: string,
    locale: Locale,
  ): Promise<void> {
    const tokenHash = this.hasher.hashInviteToken(token);
    const window = this.config.get('OTP_RATE_LIMIT_WINDOW_SECONDS', {
      infer: true,
    });
    await this.rateLimit.consume(
      `invite-start:ip:${ip}`,
      this.config.get('OTP_RATE_LIMIT_PER_IP', { infer: true }),
      window,
    );
    await this.rateLimit.consume(
      `invite-start:token:${tokenHash}`,
      this.config.get('OTP_RATE_LIMIT_PER_IDENTIFIER', { infer: true }),
      window,
    );
    void this.sendCode(tokenHash, locale).catch((error: unknown) => {
      this.logger.error(
        `invite code failed: ${error instanceof Error ? error.name : 'Error'}`,
      );
    });
  }

  async completeAcceptance(
    token: string,
    code: string,
  ): Promise<AcceptedInvite> {
    const tokenHash = this.hasher.hashInviteToken(token);
    const pointer = await this.livePointer(tokenHash);
    if (!pointer) {
      await this.tokenInvalid('complete', 'unknown_or_expired');
      throw invalidCode();
    }
    if (!(await this.otp.verifyInvite(tokenHash, code))) {
      await this.securityEvents.record('otp.verify_failed', {
        tenantId: pointer.tenantId,
        metadata: { purpose: 'invite_accept' },
      });
      throw invalidCode();
    }
    // Everything below is written by the system on the invitee's behalf; the
    // OTP proved they own the invited email (ADR 0014: actor `system`).
    const accepted = await this.cls.run({ ifNested: 'inherit' }, () => {
      this.cls.set('auditActor', { type: 'system', id: null });
      return this.tenantTx.runInTenantUnsafe(pointer.tenantId, (tx) =>
        this.accept(tx, pointer.tenantId, pointer.inviteId),
      );
    });
    if (!accepted) {
      await this.tokenInvalid('complete', 'invite_not_pending');
      throw invalidCode();
    }
    return accepted;
  }

  // --------------------------------------------------------------------------

  private async sendCode(tokenHash: string, locale: Locale): Promise<void> {
    const pointer = await this.livePointer(tokenHash);
    if (!pointer) return this.tokenInvalid('start', 'unknown_or_expired');
    const invite = await this.tenantTx.runInTenantUnsafe(
      pointer.tenantId,
      (tx) =>
        tx.householdInvite.findFirst({
          where: {
            id: pointer.inviteId,
            status: 'pending',
            expiresAt: { gt: new Date() },
          },
          select: { email: true },
        }),
    );
    if (!invite) return this.tokenInvalid('start', 'invite_not_pending');
    await this.otp.issueForInvite(tokenHash, invite.email, locale);
  }

  /** The token's compound and invite, if the token exists, is unexpired and the compound is active. */
  private async livePointer(tokenHash: string) {
    const row = await this.globalDb.inviteToken.findUnique({
      where: { tokenHash },
      include: { tenant: { select: { status: true } } },
    });
    if (!row || row.expiresAt <= new Date() || row.tenant.status !== 'active')
      return null;
    return { tenantId: row.tenantId, inviteId: row.inviteId };
  }

  private async accept(
    tx: TenantTxClient,
    tenantId: string,
    inviteId: string,
  ): Promise<AcceptedInvite | null> {
    const found = await tx.householdInvite.findUnique({
      where: { id: inviteId },
    });
    if (!found) return null;
    await lockUnits(tx, [found.unitId]);
    // Re-read under the lock: a concurrent revoke or acceptance may have won.
    const invite = await tx.householdInvite.findUniqueOrThrow({
      where: { id: inviteId },
    });
    if (invite.status !== 'pending') return null;
    if (await expireIfDue(tx, invite, this.globalDb)) return null;

    // The OTP proved ownership of the email: an existing family account of
    // this compound with it is the same person, and is reused.
    const existing = await tx.account.findFirst({
      where: { type: 'family', email: invite.email },
    });
    let accountId: string;
    if (existing) {
      accountId = existing.id;
      if (existing.status !== 'active') {
        await this.writer.setStatus(tx, existing.id, 'active');
      }
    } else {
      const created = await this.writer.create(tx, tenantId, {
        type: 'family',
        fullName: invite.fullName,
        nationalId: invite.idDocumentNumber,
        phone: invite.phone,
        email: invite.email,
      });
      accountId = created.id;
    }

    const nationalId =
      parseEgyptianNationalId(existing?.idDocumentNumber ?? '') ??
      parseEgyptianNationalId(invite.idDocumentNumber);
    const { familyJoinRequiresApproval } = await this.settings.inTx(
      tx,
      tenantId,
    );
    const status = familyJoinRequiresApproval ? 'pending_approval' : 'active';
    const memberId = newId();
    await tx.householdMember.create({
      data: {
        id: memberId,
        tenantId,
        unitId: invite.unitId,
        accountId,
        relation: invite.relation,
        isMinor: false,
        birthDate: nationalId!.birthDate,
        status,
        addedById: invite.invitedById,
      },
    });
    await tx.householdInvite.update({
      where: { id: invite.id },
      data: { status: 'accepted', acceptedAccountId: accountId },
    });
    await this.globalDb
      .in(tx)
      .inviteToken.deleteMany({ where: { tokenHash: invite.tokenHash } });
    await this.audit.record(tx, {
      action: 'household.invite_accepted',
      targetId: invite.id,
      changes: diffChanges(
        { status: 'pending' },
        { status: 'accepted' },
        'household.invite_accepted',
      ),
      metadata: {
        invitedBy: invite.invitedById,
        unitId: invite.unitId,
        accountId,
        memberId,
        membershipStatus: status,
        accountCreated: !existing,
      },
    });
    return { accountId, memberId, membershipStatus: status };
  }

  private tokenInvalid(stage: 'start' | 'complete', reason: string) {
    return this.securityEvents.record('invite.token_invalid', {
      metadata: { stage, reason },
    });
  }
}

function invalidCode() {
  return appError.unauthorized(
    ErrorCode.OTP_INVALID,
    'Invalid or expired code',
  );
}
