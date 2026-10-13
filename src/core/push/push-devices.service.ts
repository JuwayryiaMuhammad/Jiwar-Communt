import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { PushPlatform } from '@prisma/client';
import { isUUID } from 'class-validator';
import { AccountLifecycle } from '../accounts/account-lifecycle';
import { IdentifierHasher } from '../auth/identifier';
import { RequestContext } from '../common/cls/request-context';
import { appError, ErrorCode } from '../common/errors';
import { sha256 } from '../common/refresh-token';
import { newId } from '../common/uuid';
import { GlobalDbService } from '../database/global-db.service';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../exports/export-sections';

/** A phone past this many is the least recently used one's replacement. */
export const PUSH_DEVICE_LIMIT = 10;

/**
 * The phones an account receives pushes on (ADR 0041): one FCM token per
 * account and install, bound to the session that registered it.
 *
 * A token goes when its session does. A logout or a single revoke deletes
 * it with the session (SessionService, AccountSelfService); revoking every
 * session, a deactivation, a freeze and an erasure delete all of the
 * account's, here, inside the transaction that does it; a suspended
 * compound loses all of its tokens (TenantsService). PushProcessor checks
 * the session again before every send, so a session that merely expired
 * stops receiving too.
 *
 * Registration is not audited: like `known_devices`, it is the app's
 * housekeeping (it runs at every start), and every removal follows an
 * entry that is already recorded (`session.revoked`, `account.*`).
 *
 * The personal-data export lists them as `push-devices.json`: `id`,
 * `platform`, `createdAt`, `lastUsedAt` — never the token.
 */
@Injectable()
export class PushDevices implements OnModuleInit {
  constructor(
    private readonly ctx: RequestContext,
    private readonly tenantTx: TenantTx,
    private readonly globalDb: GlobalDbService,
    private readonly hasher: IdentifierHasher,
    private readonly lifecycle: AccountLifecycle,
    private readonly sections: ExportSections,
  ) {}

  onModuleInit(): void {
    const drop = async (tx: TenantTxClient, account: { id: string }) => {
      await this.globalDb
        .in(tx)
        .pushDevice.deleteMany({ where: { accountId: account.id } });
    };
    this.lifecycle.onSessionsRevoked(drop);
    this.lifecycle.onFrozen(drop);
    // Erasure runs the deactivation handlers too: deleting twice is nothing.
    this.lifecycle.onDeactivated(async (tx, account) => {
      await drop(tx, account);
      return [];
    });
    this.lifecycle.onErasing(async (tx, account) => {
      await drop(tx, account);
      return [];
    });
    this.sections.register('push_devices', (s) => this.exported(s));
  }

  /**
   * Registers this install's token, replacing the one it had. Under the
   * account's lock, with the request's own session locked and checked
   * again: a logout or a revoke-all racing this request either waits and
   * then deletes the new row, or already won and this fails as signed out.
   */
  async register(
    installId: string | undefined,
    input: { token: string; platform: PushPlatform },
  ): Promise<void> {
    const accountId = this.ctx.accountId;
    const tenantId = this.ctx.tenantId;
    const sessionId = this.ctx.sessionIdOrNull();
    const installHash = this.installHash(accountId, installId);
    const tokenHash = sha256(input.token);
    await this.tenantTx.withTenantTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${accountId}::uuid FOR UPDATE`;
      await this.requireLive(tx, accountId, tenantId, sessionId);
      // One row per token, anywhere: two accounts registering the same
      // token at once take turns here.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`push-token:${tokenHash}`}))`;
      const global = this.globalDb.in(tx);
      // The install signed in to another account (or was reinstalled):
      // the token moves, it is never on two rows.
      await global.pushDevice.deleteMany({
        where: { tokenHash, NOT: { accountId, installHash } },
      });
      const now = new Date();
      const fields = {
        tenantId,
        sessionId: sessionId as string,
        platform: input.platform,
        token: input.token,
        tokenHash,
        lastUsedAt: now,
      };
      await global.pushDevice.upsert({
        where: { accountId_installHash: { accountId, installHash } },
        create: { id: newId(), accountId, installHash, ...fields },
        update: fields,
      });
      const extra = await global.pushDevice.findMany({
        where: { accountId },
        orderBy: [{ lastUsedAt: 'desc' }, { id: 'desc' }],
        skip: PUSH_DEVICE_LIMIT,
        select: { id: true },
      });
      if (extra.length)
        await global.pushDevice.deleteMany({
          where: { id: { in: extra.map((d) => d.id) } },
        });
    });
  }

  /** This install's token, if it has one. Safe to repeat. */
  async remove(installId: string | undefined): Promise<void> {
    const accountId = this.ctx.accountId;
    await this.globalDb.pushDevice.deleteMany({
      where: { accountId, installHash: this.installHash(accountId, installId) },
    });
  }

  /** The same keyed hash `known_devices` keeps: the install id is not stored. */
  private installHash(accountId: string, installId: string | undefined) {
    if (!installId || !isUUID(installId)) {
      throw appError.badRequest(
        ErrorCode.INSTALL_ID_REQUIRED,
        'The X-Jiwar-Install-Id header must carry the install id (a UUID)',
      );
    }
    return this.hasher.hashDevice(accountId, 'app', installId.toLowerCase());
  }

  private async requireLive(
    tx: TenantTxClient,
    accountId: string,
    tenantId: string,
    sessionId: string | null,
  ): Promise<void> {
    const account = await tx.account.findUnique({
      where: { id: accountId },
      select: { status: true },
    });
    // FOR SHARE: ending this session waits for this transaction.
    const live = sessionId
      ? await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM sessions
           WHERE id = ${sessionId}::uuid
             AND account_id = ${accountId}::uuid
             AND tenant_id = ${tenantId}::uuid
             AND revoked_at IS NULL
             AND expires_at > now()
             FOR SHARE`
      : [];
    if (account?.status !== 'active' || !live.length) {
      throw appError.unauthorized(
        ErrorCode.UNAUTHENTICATED,
        'Authentication required',
      );
    }
  }

  private async *exported(s: ExportSubject): AsyncIterable<ExportEntry> {
    const rows = await this.globalDb.pushDevice.findMany({
      where: { accountId: s.accountId, tenantId: s.tenantId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, platform: true, createdAt: true, lastUsedAt: true },
    });
    yield { path: 'push-devices.json', json: rows };
  }
}
