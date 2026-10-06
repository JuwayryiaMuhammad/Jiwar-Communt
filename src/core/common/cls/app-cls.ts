import type { ClsStore } from 'nestjs-cls';
import type { AccountType } from '@prisma/client';

/**
 * Per-request context. Filled by JwtAuthGuard from the verified access token;
 * `tenantId` is the ONLY source of the tenant for database access (ADR 0005).
 */
export interface AppClsStore extends ClsStore {
  tenantId?: string;
  accountId?: string;
  accountType?: AccountType;
  /** The session behind the access token (`sid`). */
  sessionId?: string;
  /** Set by PermissionsGuard from the database on every request (ADR 0010). */
  roleId?: string;
  permissionsVersion?: number;
  /** Platform routes only (ADR 0011); never set together with tenantId. */
  platformAdminId?: string;
  platformScope?: 'full' | 'password_change';
  /** Set by TenantTx while a tenant transaction callback is running. */
  inTenantTx?: boolean;
  /**
   * The tenant set with set_config on the running TenantTx transaction —
   * where an audit entry of that transaction belongs (ADR 0014).
   */
  txTenantId?: string;
  /** Request origin, for audit entries and security events. */
  ip?: string;
  userAgent?: string;
  /**
   * The request's Idempotency-Key while an `@Idempotent()` route runs
   * (ADR 0028); the service claims it in its transaction.
   */
  idempotency?: {
    key: string;
    hash: string;
    route: string;
    status: number;
    claimed: boolean;
  };
  /**
   * Explicit audit actor, set ONLY by trusted entry points (seed, CLIs, and
   * a verified email action token, which acts as the account it was sent
   * to; ADR 0036) — never from unverified request data.
   */
  auditActor?: {
    type: 'account' | 'platform_admin' | 'system';
    id: string | null;
  };
}
