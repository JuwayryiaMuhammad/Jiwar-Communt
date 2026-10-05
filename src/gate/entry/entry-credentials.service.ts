import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import type { AppClsStore } from '../../core/common/cls/app-cls';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import { CommunityGatePort } from '../../community';
import { ENTRY_STEP_SECONDS, EntrySecrets } from './entry-secrets';

/** Live credentials one account may hold: its phones (ADR 0031). */
export const ENTRY_CREDENTIAL_LIMIT = 3;

/** The idempotency resource of an issue: replayed by deriving, never stored. */
export const ENTRY_CREDENTIAL_RESOURCE = 'entry_credential';

/** Why a credential was revoked: the CHECK `entry_credentials_revoke_reason`. */
export const ENTRY_REVOKE_REASONS = [
  'owner',
  'sessions_revoked',
  'account_deactivated',
  'account_frozen',
  'account_erased',
  'not_resident',
  // Only by the operator, after a rotation of ENTRY_CREDENTIAL_KEY (ADR 0031).
  'key_rotated',
] as const;
export type EntryRevokeReason = (typeof ENTRY_REVOKE_REASONS)[number];

/** What the phone keeps: the secret is shown here and never again. */
export interface IssuedCredential {
  id: string;
  /** base64url of 32 bytes, derived from the server's key. */
  secret: string;
  stepSeconds: number;
}

export interface CredentialRecord {
  id: string;
  deviceName: string | null;
  createdAt: Date;
}

const notFound = () =>
  appError.notFound(
    ErrorCode.ENTRY_CREDENTIAL_NOT_FOUND,
    'Entry credential not found',
  );

/**
 * The resident's phones (ADR 0031). A credential is a row; its secret is
 * derived from ENTRY_CREDENTIAL_KEY and never stored, so nothing here can
 * show it again.
 *
 * Ordering rules, so no pair of requests can leave a live credential behind
 * a change that should have ended it: issuing, every revocation hook and
 * "revoke all sessions" take the **account row lock first** and read after
 * it. Issuing re-checks its own session, the account's state and where the
 * account lives under that lock, and counts the live credentials there, so
 * the limit holds under parallel requests.
 */
@Injectable()
export class EntryCredentialsService implements OnModuleInit {
  constructor(
    private readonly ctx: RequestContext,
    private readonly cls: ClsService<AppClsStore>,
    private readonly tenantTx: TenantTx,
    private readonly globalDb: GlobalDbService,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly idempotency: IdempotencyService,
    private readonly lifecycle: AccountLifecycle,
    private readonly community: CommunityGatePort,
    private readonly secrets: EntrySecrets,
  ) {}

  onModuleInit(): void {
    // A replay of an issue derives the same id and secret again.
    this.idempotency.renderer(ENTRY_CREDENTIAL_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const row = await tx.entryCredential.findUnique({ where: { id } });
        if (!row) throw notFound();
        return this.render(row.tenantId, row.id);
      }),
    );
    const endAll =
      (reason: EntryRevokeReason) =>
      async (tx: TenantTxClient, account: { id: string }) => {
        await this.lock(tx, account.id);
        await this.revokeAllOf(tx, account.id, reason);
      };
    this.lifecycle.onDeactivated(async (tx, account) => {
      await endAll('account_deactivated')(tx, account);
      return [];
    });
    this.lifecycle.onFrozen(endAll('account_frozen'));
    this.lifecycle.onErasing(async (tx, account) => {
      await endAll('account_erased')(tx, account);
      return [];
    });
    this.lifecycle.onSessionsRevoked(endAll('sessions_revoked'));
    // Where the account lives may have changed: re-check, after the action's
    // writes. Verify checks again at every scan, so this only keeps an old
    // phone from coming back to life when the person moves back in.
    this.lifecycle.onResidenceChanged(async (tx, account) => {
      await this.lock(tx, account.id);
      const units = await this.community.unitsWhere(
        tx,
        account.id,
        'gateEntry',
      );
      if (units.length === 0)
        await this.revokeAllOf(tx, account.id, 'not_resident');
    });
  }

  /**
   * Registers a phone. `Idempotency-Key`: a retry gets the same credential
   * and secret back (re-derived), so a lost response never costs a slot.
   */
  async issue(input: { deviceName?: string }): Promise<IssuedCredential> {
    const accountId = this.ctx.accountId;
    const tenantId = this.ctx.tenantId;
    const sessionId = this.cls.get('sessionId');
    const deviceName = input.deviceName?.trim() || null;
    const id = newId();
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lock(tx, accountId);
      await this.idempotency.claim(tx, { type: ENTRY_CREDENTIAL_RESOURCE, id });
      await this.requireLive(tx, accountId, tenantId, sessionId);
      const units = await this.community.unitsWhere(tx, accountId, 'gateEntry');
      if (units.length === 0) {
        throw appError.forbidden(
          ErrorCode.NOT_A_RESIDENT,
          'You do not live in a unit of this compound',
        );
      }
      const live = await tx.entryCredential.count({
        where: { accountId, revokedAt: null },
      });
      if (live >= ENTRY_CREDENTIAL_LIMIT) {
        throw appError.conflict(
          ErrorCode.ENTRY_CREDENTIAL_LIMIT_REACHED,
          'This account already has as many phones as it may register',
          { params: { limit: ENTRY_CREDENTIAL_LIMIT } },
        );
      }
      await tx.entryCredential.create({
        data: { id, tenantId, accountId, deviceName },
      });
      await this.audit.record(tx, {
        action: 'entry_credential.issued',
        targetId: id,
      });
      // A stolen account's first move: the owner sees it and may revoke it.
      await this.notifier.notify(tx, [accountId], {
        kind: 'entry_credential.issued',
        params: {},
        targetId: id,
      });
      return this.render(tenantId, id);
    });
  }

  /** The caller's live phones, oldest first. At most the limit. */
  list(): Promise<CredentialRecord[]> {
    const accountId = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.entryCredential.findMany({
        where: { accountId, revokedAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return rows.map((r) => ({
        id: r.id,
        deviceName: r.deviceName,
        createdAt: r.createdAt,
      }));
    });
  }

  /**
   * One of the caller's own. Another account's, another compound's and an
   * unknown id are one answer; an own credential already revoked is a no-op,
   * so a retried revoke is safe.
   */
  revoke(id: string): Promise<void> {
    const accountId = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lock(tx, accountId);
      const row = await tx.entryCredential.findFirst({
        where: { id, accountId },
      });
      if (!row) throw notFound();
      if (row.revokedAt) return;
      await this.revokeOne(tx, row.id, 'owner');
    });
  }

  /** Every live credential of the account, in the caller's transaction. */
  async revokeAllOf(
    tx: TenantTxClient,
    accountId: string,
    reason: EntryRevokeReason,
  ): Promise<number> {
    const live = await tx.entryCredential.findMany({
      where: { accountId, revokedAt: null },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    for (const { id } of live) await this.revokeOne(tx, id, reason);
    return live.length;
  }

  private async revokeOne(
    tx: TenantTxClient,
    id: string,
    reason: EntryRevokeReason,
  ): Promise<void> {
    // The device name is personal: it goes with the credential's life.
    const { count } = await tx.entryCredential.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason, deviceName: null },
    });
    if (!count) return;
    await this.audit.record(tx, {
      action: 'entry_credential.revoked',
      targetId: id,
      metadata: { reasonCode: reason },
    });
  }

  /**
   * The request's own session and account are still good, under the account
   * lock: a revoke-all or a deactivation that committed while this request
   * waited ends it here (the guard checked before the wait).
   */
  private async requireLive(
    tx: TenantTxClient,
    accountId: string,
    tenantId: string,
    sessionId: string | undefined,
  ): Promise<void> {
    const account = await tx.account.findUnique({
      where: { id: accountId },
      select: { status: true },
    });
    const session = sessionId
      ? await this.globalDb.in(tx).session.findFirst({
          where: {
            id: sessionId,
            accountId,
            tenantId,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        })
      : null;
    if (account?.status !== 'active' || !session) {
      throw appError.unauthorized(
        ErrorCode.UNAUTHENTICATED,
        'Authentication required',
      );
    }
  }

  private async lock(tx: TenantTxClient, accountId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${accountId}::uuid FOR UPDATE`;
  }

  private render(tenantId: string, id: string): IssuedCredential {
    return {
      id,
      secret: this.secrets.encodedSecretFor(tenantId, id),
      stepSeconds: ENTRY_STEP_SECONDS,
    };
  }
}
