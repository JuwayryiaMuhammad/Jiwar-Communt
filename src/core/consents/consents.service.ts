import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { AccountConsent, ConsentEvent } from '@prisma/client';
import { AccountLifecycle } from '../accounts/account-lifecycle';
import { AuditService } from '../audit/audit.service';
import { RequestContext } from '../common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../common/errors';
import { newId } from '../common/uuid';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import {
  CONSENT_CODES,
  currentVersion,
  isConsentCode,
  type ConsentCode,
} from './consent-catalog';

/** A consent as the account (or a manager assisting it) sees it. */
export interface ConsentState {
  code: ConsentCode;
  /** The catalog's current version: the one a grant must answer. */
  version: number;
  /** Granted at the current version (an older grant does not count). */
  granted: boolean;
  grantedAt: Date | null;
}

/** Who acts for the account, and why (ADR 0036). */
export interface ConsentAssist {
  reasonCode: string;
}

type Projection = Pick<
  AccountConsent,
  'grantedVersion' | 'grantedAt' | 'lastEventId'
>;

/**
 * Consents (ADR 0036): a closed catalog of codes with versions, an
 * append-only history of grants and revocations, and a projection of the
 * current state written with each event and rebuildable from them.
 *
 * - A grant must answer the catalog's current version
 *   (CONSENT_VERSION_MISMATCH otherwise); a bumped version makes earlier
 *   grants stop counting.
 * - A revocation is allowed at any time and takes effect at once: readers
 *   check `isGranted` at read time.
 * - Each change locks the account's projection row, so a grant and a
 *   revocation never interleave.
 */
@Injectable()
export class ConsentsService implements OnModuleInit {
  constructor(
    private readonly ctx: RequestContext,
    private readonly tenantTx: TenantTx,
    private readonly audit: AuditService,
    private readonly lifecycle: AccountLifecycle,
  ) {}

  onModuleInit(): void {
    // Erasure: whatever was granted is revoked by the system, so the
    // projection stays what the history says.
    this.lifecycle.onErasing(async (tx, account) => {
      const granted = await tx.accountConsent.findMany({
        where: { accountId: account.id, grantedVersion: { not: null } },
        select: { code: true },
      });
      for (const g of granted)
        if (isConsentCode(g.code))
          await this.change(tx, account.id, g.code, 'revoke', null, 'system');
      return [];
    });
  }

  async mine(): Promise<ConsentState[]> {
    return this.tenantTx.withTenantTx((tx) =>
      this.states(tx, this.ctx.accountId),
    );
  }

  async grant(code: string, version: number): Promise<ConsentState> {
    const known = checkCode(code);
    return this.tenantTx.withTenantTx((tx) =>
      this.change(tx, this.ctx.accountId, known, 'grant', version, 'self'),
    );
  }

  async revoke(code: string): Promise<ConsentState> {
    const known = checkCode(code);
    return this.tenantTx.withTenantTx((tx) =>
      this.change(tx, this.ctx.accountId, known, 'revoke', null, 'self'),
    );
  }

  /** Whether the account has granted `code` at its current version, now. */
  async isGranted(
    tx: TenantTxClient,
    accountId: string,
    code: ConsentCode,
  ): Promise<boolean> {
    const row = await tx.accountConsent.findFirst({
      where: { accountId, code },
      select: { grantedVersion: true },
    });
    return row?.grantedVersion === currentVersion(code);
  }

  /** Every catalog consent of the account. */
  async states(tx: TenantTxClient, accountId: string): Promise<ConsentState[]> {
    const rows = await tx.accountConsent.findMany({ where: { accountId } });
    return CONSENT_CODES.map((code) => {
      const row = rows.find((r) => r.code === code);
      const version = currentVersion(code);
      const granted = row?.grantedVersion === version;
      return {
        code,
        version,
        granted,
        grantedAt: granted ? (row?.grantedAt ?? null) : null,
      };
    });
  }

  /**
   * A grant or a revocation under the projection row's lock: one event,
   * the projection, and the audit entry, in the caller's transaction. A
   * change that changes nothing (granting what is granted, revoking what is
   * not) writes nothing.
   */
  async change(
    tx: TenantTxClient,
    accountId: string,
    code: ConsentCode,
    action: 'grant' | 'revoke',
    version: number | null,
    by: 'self' | 'system' | ConsentAssist,
  ): Promise<ConsentState> {
    const current = currentVersion(code);
    if (action === 'grant' && version !== current) {
      throw appError.conflict(
        ErrorCode.CONSENT_VERSION_MISMATCH,
        'Grant the current version of this consent',
        { params: { current } },
      );
    }
    // The transaction's own tenant: also right in an erasure run by the sweep.
    const tenantId = await this.tenantOf(tx);
    await tx.$executeRaw`
      INSERT INTO account_consents (tenant_id, account_id, code, updated_at)
      VALUES (${tenantId}::uuid, ${accountId}::uuid, ${code}, now())
      ON CONFLICT DO NOTHING`;
    await tx.$queryRaw`
      SELECT code FROM account_consents
       WHERE account_id = ${accountId}::uuid AND code = ${code}
         FOR UPDATE`;
    const row = await tx.accountConsent.findFirstOrThrow({
      where: { accountId, code },
    });
    const noop =
      action === 'grant'
        ? row.grantedVersion === current
        : row.grantedVersion === null;
    if (!noop) {
      const assist = typeof by === 'object' ? by : null;
      const eventId = newId();
      const now = new Date();
      const eventVersion = action === 'grant' ? current : row.grantedVersion!;
      await tx.consentEvent.create({
        data: {
          id: eventId,
          tenantId,
          accountId,
          code,
          version: eventVersion,
          action,
          actorType: by === 'system' ? 'system' : 'account',
          actorAccountId:
            by === 'system' ? null : assist ? this.ctx.accountId : accountId,
          assisted: !!assist,
          assistReasonCode: assist?.reasonCode ?? null,
          occurredAt: now,
        },
      });
      await tx.accountConsent.updateMany({
        where: { accountId, code },
        data:
          action === 'grant'
            ? { grantedVersion: current, grantedAt: now, lastEventId: eventId }
            : { grantedVersion: null, grantedAt: null, lastEventId: eventId },
      });
      await this.audit.record(tx, {
        action: action === 'grant' ? 'consent.granted' : 'consent.revoked',
        targetId: accountId,
        metadata: {
          code,
          version: eventVersion,
          assisted: !!assist,
          ...(assist ? { reasonCode: assist.reasonCode } : {}),
          ...(by === 'system' ? { reasonCode: 'erasure' } : {}),
        },
      });
    }
    return (await this.states(tx, accountId)).find((s) => s.code === code)!;
  }

  /**
   * The projection from the events alone (ADR 0036), oldest first. Equal
   * to what `account_consents` holds; a test compares the two.
   */
  async rebuild(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<Map<string, Projection>> {
    const events: ConsentEvent[] = await tx.consentEvent.findMany({
      where: { accountId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    const out = new Map<string, Projection>();
    for (const e of events)
      out.set(
        e.code,
        e.action === 'grant'
          ? {
              grantedVersion: e.version,
              grantedAt: e.occurredAt,
              lastEventId: e.id,
            }
          : { grantedVersion: null, grantedAt: null, lastEventId: e.id },
      );
    return out;
  }

  private async tenantOf(tx: TenantTxClient): Promise<string> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid AS id`;
    return row.id;
  }
}

/** A catalog code, or the field error the DTO gives. */
export function checkCode(code: string): ConsentCode {
  if (!isConsentCode(code))
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Unknown consent', {
      fields: [
        {
          field: 'code',
          code: FieldErrorCode.INVALID_VALUE,
          params: { allowed: [...CONSENT_CODES] },
        },
      ],
    });
  return code;
}
