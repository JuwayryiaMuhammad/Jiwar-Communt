import { Injectable, Logger } from '@nestjs/common';
import type { AccountStatus, Locale, TenantStatus } from '@prisma/client';
import { RoleProvisioner } from '../access/role-provisioner';
import { runAfterCommit } from '../accounts/account-lifecycle';
import { AccountWriter } from '../accounts/account-writer';
import { diffChanges } from '../audit/diff';
import { PlatformAuditService } from '../audit/platform-audit.service';
import { SecurityEventsService } from '../audit/security-events.service';
import { appError, ErrorCode, FieldErrorCode } from '../common/errors';
import type { IdentityDocumentInput } from '../common/identity-document';
import { newId } from '../common/uuid';
import { GlobalDbService } from '../database/global-db.service';
import { TenantTx } from '../database/tenant-tx.service';
import { TenantSettingsService } from '../tenant-settings/tenant-settings.service';

export interface NewManager extends IdentityDocumentInput {
  fullName: string;
  phone: string;
  email: string;
  preferredLocale?: Locale;
}

export interface TenantSummary {
  id: string;
  name: string;
  status: TenantStatus;
  createdAt: Date;
}

/** Managers are the platform's customers: contact details are visible. */
export interface ManagerSummary {
  id: string;
  fullName: string;
  email: string;
  /** Null only while the account is frozen (ADR 0023). */
  phone: string | null;
  status: AccountStatus;
}

export interface TenantDetails extends TenantSummary {
  managers: ManagerSummary[];
}

const MANAGER_FIELDS = {
  id: true,
  fullName: true,
  email: true,
  phone: true,
  status: true,
} as const;

/**
 * Compounds, from the platform owner's side (ADR 0011). Manages compounds
 * and their manager accounts only: no method here returns units, residents
 * or occupancies, and none should be added — support access to compound data
 * is a separate, audited feature.
 */
@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(
    private readonly globalDb: GlobalDbService,
    private readonly tenantTx: TenantTx,
    private readonly provisioner: RoleProvisioner,
    private readonly writer: AccountWriter,
    private readonly platformAudit: PlatformAuditService,
    private readonly securityEvents: SecurityEventsService,
    private readonly settings: TenantSettingsService,
  ) {}

  /**
   * One transaction: the compound, its default roles and permissions
   * (ADR 0010), its settings (ADR 0016) and its first manager with login
   * identifiers.
   */
  async createTenant(input: {
    name: string;
    manager: NewManager;
  }): Promise<TenantDetails> {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 200) {
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid compound name',
        {
          fields: [
            {
              field: 'name',
              code: FieldErrorCode.INVALID_LENGTH,
              params: { min: 2, max: 200 },
            },
          ],
        },
      );
    }
    const id = newId();
    return this.tenantTx.runInTenantUnsafe(id, async (tx) => {
      const tenant = await this.globalDb
        .in(tx)
        .tenant.create({ data: { id, name } });
      await this.provisioner.provision(tx, id);
      await this.settings.create(tx, id);
      await this.platformAudit.record(tx, {
        action: 'tenant.created',
        targetId: id,
        targetTenantId: id,
        changes: diffChanges(
          null,
          { name: tenant.name, status: tenant.status },
          'tenant.created',
        ),
      });
      // Audited as account.created in the compound's own log.
      const manager = await this.writer.create(tx, id, {
        ...input.manager,
        type: 'manager',
      });
      return { ...summary(tenant), managers: [pickManager(manager)] };
    });
  }

  async list(): Promise<TenantSummary[]> {
    const tenants = await this.globalDb.tenant.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return tenants.map(summary);
  }

  async get(tenantId: string): Promise<TenantDetails> {
    const tenant = await this.findTenant(tenantId);
    const managers = await this.tenantTx.runInTenantUnsafe(tenantId, (tx) =>
      tx.account.findMany({
        where: { type: 'manager' },
        select: MANAGER_FIELDS,
        orderBy: { createdAt: 'asc' },
      }),
    );
    return { ...summary(tenant), managers };
  }

  /** Suspending ends every session in the compound at once. */
  async setStatus(
    tenantId: string,
    status: TenantStatus,
  ): Promise<TenantSummary> {
    const before = await this.findTenant(tenantId);
    const { tenant, sessionsRevoked } = await this.tenantTx.runInTenantUnsafe(
      tenantId,
      async (tx) => {
        const global = this.globalDb.in(tx);
        const updated = await global.tenant.update({
          where: { id: tenantId },
          data: { status },
        });
        const revoked =
          status === 'suspended'
            ? (
                await global.session.updateMany({
                  where: { tenantId, revokedAt: null },
                  data: { revokedAt: new Date() },
                })
              ).count
            : 0;
        if (before.status !== status) {
          await this.platformAudit.record(tx, {
            action: 'tenant.status_changed',
            targetId: tenantId,
            targetTenantId: tenantId,
            changes: diffChanges(
              { status: before.status },
              { status },
              'tenant.status_changed',
            ),
            metadata: { sessionsRevoked: revoked },
          });
        }
        return { tenant: updated, sessionsRevoked: revoked };
      },
    );
    if (sessionsRevoked) {
      // After commit: a rolled-back suspension must leave no event.
      await this.securityEvents.record('session.revoked', {
        tenantId,
        metadata: { reason: 'tenant_suspended', count: sessionsRevoked },
      });
    }
    return summary(tenant);
  }

  async addManager(
    tenantId: string,
    manager: NewManager,
  ): Promise<ManagerSummary> {
    await this.findTenant(tenantId);
    const account = await this.tenantTx.runInTenantUnsafe(
      tenantId,
      async (tx) => {
        const created = await this.writer.create(tx, tenantId, {
          ...manager,
          type: 'manager',
        });
        await this.platformAudit.record(tx, {
          action: 'tenant.manager_added',
          targetId: created.id,
          targetTenantId: tenantId,
        });
        return created;
      },
    );
    return pickManager(account);
  }

  /** Only manager accounts; anything else in the compound is "not found". */
  async setManagerStatus(
    tenantId: string,
    accountId: string,
    status: AccountStatus,
  ): Promise<ManagerSummary> {
    await this.findTenant(tenantId);
    const change = await this.tenantTx.runInTenantUnsafe(
      tenantId,
      async (tx) => {
        const existing = await tx.account.findUnique({
          where: { id: accountId },
          select: { type: true },
        });
        if (existing?.type !== 'manager') return null;
        return this.writer.setStatus(tx, accountId, status);
      },
    );
    if (!change) {
      throw appError.notFound(ErrorCode.ACCOUNT_NOT_FOUND, 'Manager not found');
    }
    await runAfterCommit(change.afterCommit, this.logger);
    if (change.sessionsRevoked) {
      await this.securityEvents.record('session.revoked', {
        tenantId,
        accountId,
        metadata: {
          reason: 'account_deactivated',
          count: change.sessionsRevoked,
        },
      });
    }
    return pickManager(change.account);
  }

  private async findTenant(tenantId: string) {
    const tenant = await this.globalDb.tenant.findUnique({
      where: { id: tenantId },
    });
    if (!tenant)
      throw appError.notFound(ErrorCode.TENANT_NOT_FOUND, 'Compound not found');
    return tenant;
  }
}

function summary(t: TenantSummary): TenantSummary {
  return { id: t.id, name: t.name, status: t.status, createdAt: t.createdAt };
}

function pickManager(a: ManagerSummary): ManagerSummary {
  return {
    id: a.id,
    fullName: a.fullName,
    email: a.email,
    phone: a.phone,
    status: a.status,
  };
}
