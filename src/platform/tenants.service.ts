import { Injectable } from '@nestjs/common';
import type { AccountStatus, Locale, TenantStatus } from '@prisma/client';
import { RoleProvisioner } from '../access/role-provisioner';
import { AccountWriter } from '../accounts/account-writer';
import { appError, ErrorCode, FieldErrorCode } from '../common/errors';
import { newId } from '../common/uuid';
import { GlobalDbService } from '../database/global-db.service';
import { TenantTx } from '../database/tenant-tx.service';

export interface NewManager {
  fullName: string;
  nationalId: string;
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
  phone: string;
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
  constructor(
    private readonly globalDb: GlobalDbService,
    private readonly tenantTx: TenantTx,
    private readonly provisioner: RoleProvisioner,
    private readonly writer: AccountWriter,
  ) {}

  /**
   * One transaction: the compound, its default roles and permissions
   * (ADR 0010) and its first manager with login identifiers.
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
    await this.findTenant(tenantId);
    const tenant = await this.tenantTx.runInTenantUnsafe(
      tenantId,
      async (tx) => {
        const global = this.globalDb.in(tx);
        const updated = await global.tenant.update({
          where: { id: tenantId },
          data: { status },
        });
        if (status === 'suspended') {
          await global.session.updateMany({
            where: { tenantId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }
        return updated;
      },
    );
    return summary(tenant);
  }

  async addManager(
    tenantId: string,
    manager: NewManager,
  ): Promise<ManagerSummary> {
    await this.findTenant(tenantId);
    const account = await this.tenantTx.runInTenantUnsafe(tenantId, (tx) =>
      this.writer.create(tx, tenantId, { ...manager, type: 'manager' }),
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
    const account = await this.tenantTx.runInTenantUnsafe(
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
    if (!account) {
      throw appError.notFound(ErrorCode.ACCOUNT_NOT_FOUND, 'Manager not found');
    }
    return pickManager(account);
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
