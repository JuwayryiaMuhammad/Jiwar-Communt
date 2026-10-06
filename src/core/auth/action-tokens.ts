import { timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ActionToken, ActionTokenPurpose } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../common/cls/app-cls';
import { appError, ErrorCode } from '../common/errors';
import { newId } from '../common/uuid';
import type { Env } from '../config/env.schema';
import { GlobalDbService } from '../database/global-db.service';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { IdentifierHasher } from './identifier';

const TOKEN = /^([0-9a-f-]{36})\.([0-9a-f]{64})$/;

/** The web app's page for each purpose (docs/api/v0-notes.md). */
export const LINK_PAGES: Record<ActionTokenPurpose, string> = {
  not_me: 'not-me',
  export_download: 'export',
};

/**
 * Tokens for links in emails (ADR 0036): the unusual-login alert's "not
 * me", an assisted export's download link.
 *
 * - **Nothing secret is stored.** A row holds its id, purpose, subject,
 *   account, expiry and use count. The token is `<id>.<mac>`, where the
 *   mac is HMAC(IDENTIFIER_PEPPER, "action-token:v1:<purpose>:<id>"): only
 *   the server can make or check one, and a database dump opens nothing.
 * - **Rendered at send time.** The outbox stores the row's id; the email's
 *   renderer derives the link (`link`), so a resend carries the same one,
 *   and no outbox row, log, audit entry, notification or idempotency body
 *   ever holds it.
 * - The link is `<PUBLIC_APP_URL>/a/<page>#<token>`, one page per purpose
 *   (`not-me`, `export`) so the web app knows what to ask before it calls
 *   anything; the purpose is no secret. The fragment never reaches a
 *   server log, and the web app posts it in a body.
 * - Single-purpose (the mac is bound to it) and expiring; a use is counted
 *   under the row's lock.
 */
@Injectable()
export class ActionTokens {
  private readonly appUrl: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly hasher: IdentifierHasher,
    private readonly globalDb: GlobalDbService,
    private readonly tenantTx: TenantTx,
    private readonly cls: ClsService<AppClsStore>,
  ) {
    this.appUrl = config.get('PUBLIC_APP_URL', { infer: true });
  }

  /** A new token row in the caller's transaction; returns its id. */
  async create(
    tx: TenantTxClient,
    input: {
      tenantId: string;
      accountId: string;
      purpose: ActionTokenPurpose;
      subjectId: string;
      expiresAt: Date;
    },
  ): Promise<string> {
    const id = newId();
    await this.globalDb.in(tx).actionToken.create({ data: { id, ...input } });
    return id;
  }

  /** The token of a row: `<id>.<mac>`. Only ever put into an email body. */
  token(id: string, purpose: ActionTokenPurpose): string {
    return `${id}.${this.hasher.actionTokenMac(purpose, id)}`;
  }

  /** The link an email carries, made when the email is rendered. */
  link(id: string, purpose: ActionTokenPurpose): string {
    return `${this.appUrl}/a/${LINK_PAGES[purpose]}#${this.token(id, purpose)}`;
  }

  /**
   * Runs `fn` in the token's compound with its row locked, when the token
   * is valid for `purpose`, live and unconsumed; ACTION_TOKEN_INVALID (404)
   * otherwise, whatever the reason. The audit actor is the token's account:
   * whoever holds the email link acts as the person it was sent to.
   */
  async inTokenTenant<T>(
    raw: string,
    purpose: ActionTokenPurpose,
    fn: (tx: TenantTxClient, token: ActionToken) => Promise<T>,
    now: Date = new Date(),
  ): Promise<T> {
    const parsed = TOKEN.exec(raw ?? '');
    if (
      !parsed ||
      !safeEqualHex(parsed[2], this.hasher.actionTokenMac(purpose, parsed[1]))
    )
      throw invalid();
    const row = await this.globalDb.actionToken.findUnique({
      where: { id: parsed[1] },
    });
    if (!row || row.purpose !== purpose) throw invalid();
    return this.cls.run({ ifNested: 'inherit' }, async () => {
      // A public request has no compound until the token names one.
      this.cls.set('tenantId', row.tenantId);
      this.cls.set('auditActor', { type: 'account', id: row.accountId });
      return await this.tenantTx.runInTenantUnsafe(row.tenantId, async (tx) => {
        const [locked] = await tx.$queryRaw<
          { consumed_at: Date | null; expires_at: Date }[]
        >`SELECT consumed_at, expires_at FROM action_tokens
           WHERE id = ${row.id}::uuid FOR UPDATE`;
        if (!locked || locked.consumed_at || locked.expires_at <= now)
          throw invalid();
        return await fn(tx, row);
      });
    });
  }

  /**
   * Counts one use; the token stops working once it has `max` (1: single
   * use). Under the lock `inTokenTenant` holds.
   */
  async use(tx: TenantTxClient, id: string, max: number): Promise<number> {
    const row = await this.globalDb.in(tx).actionToken.update({
      where: { id },
      data: { uses: { increment: 1 } },
      select: { uses: true },
    });
    if (row.uses >= max)
      await this.globalDb.in(tx).actionToken.update({
        where: { id },
        data: { consumedAt: new Date() },
      });
    return row.uses;
  }
}

function invalid() {
  return appError.notFound(
    ErrorCode.ACTION_TOKEN_INVALID,
    'This link is not valid any more',
  );
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}
