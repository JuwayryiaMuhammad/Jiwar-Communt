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
   * Explicit audit actor, set ONLY by trusted entry points (seed, CLIs) —
   * never from request data.
   */
  auditActor?: {
    type: 'account' | 'platform_admin' | 'system';
    id: string | null;
  };
}
