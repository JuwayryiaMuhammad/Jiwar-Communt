import { Inject, Injectable, Logger } from '@nestjs/common';
import { ACCESS_CATALOG, type AccessCatalog } from '../access/access-catalog';
import { AuditService } from '../audit/audit.service';
import { diffChanges } from '../audit/diff';
import { GlobalDbService } from '../database/global-db.service';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';

export interface TenantSyncReport {
  tenantId: string;
  renamed: string[];
  retired: string[];
  added: string[];
  /** In the database but in none of the code lists; left untouched. */
  unknown: string[];
  rolesChanged: number;
}

/**
 * `access:sync` (ADR 0010): brings every compound's roles in line with the
 * permission catalog in code, without undoing managers' edits.
 *
 * Removal is never inferred. A permission missing from code is only removed
 * when listed in `retired`, and only moved when listed in `renamed`; anything
 * else is left alone and reported, so a rolled-back deploy cannot erase or
 * later re-grant a permission.
 *
 * Cross-tenant by nature, hence in src/platform/ where runInTenantUnsafe is
 * allowed; each compound is synced in its own transaction.
 */
@Injectable()
export class PermissionSyncService {
  private readonly logger = new Logger(PermissionSyncService.name);

  constructor(
    @Inject(ACCESS_CATALOG) private readonly catalog: AccessCatalog,
    private readonly globalDb: GlobalDbService,
    private readonly tenantTx: TenantTx,
    private readonly audit: AuditService,
  ) {}

  /** roleId → sorted permissions, inside the sync transaction. */
  private async snapshot(tx: TenantTxClient): Promise<Map<string, string[]>> {
    const rows = await tx.rolePermission.findMany({
      select: { roleId: true, permission: true },
    });
    const map = new Map<string, string[]>();
    for (const r of rows)
      map.set(r.roleId, [...(map.get(r.roleId) ?? []), r.permission]);
    for (const list of map.values()) list.sort();
    return map;
  }

  async syncAll(): Promise<TenantSyncReport[]> {
    const tenants = await this.globalDb.tenant.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const reports: TenantSyncReport[] = [];
    for (const { id } of tenants) reports.push(await this.syncTenant(id));
    return reports;
  }

  syncTenant(tenantId: string): Promise<TenantSyncReport> {
    return this.tenantTx.runInTenantUnsafe(tenantId, async (tx) => {
      // Two syncs of the same compound (e.g. two instances deploying) queue.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`access-sync:${tenantId}`}))`;
      const report: TenantSyncReport = {
        tenantId,
        renamed: [],
        retired: [],
        added: [],
        unknown: [],
        rolesChanged: 0,
      };
      const changed = new Set<string>();
      const before = await this.snapshot(tx);

      await this.applyRenames(tx, tenantId, report, changed);
      await this.applyRetirements(tx, report, changed);
      await this.applyAdditions(tx, tenantId, report, changed);
      await this.reportUnknown(tx, report);

      const after = await this.snapshot(tx);
      for (const roleId of changed) {
        const role = await tx.role.update({
          where: { id: roleId },
          data: { permissionsVersion: { increment: 1 } },
        });
        // Actor is `system`: the sync runs with no account in context.
        await this.audit.record(tx, {
          action: 'role.permissions_synced',
          targetId: roleId,
          changes: diffChanges(
            { permissions: before.get(roleId) ?? [] },
            { permissions: after.get(roleId) ?? [] },
            'role.permissions_synced',
          ),
          metadata: {
            roleKey: role.key,
            permissionsVersion: role.permissionsVersion,
            added: report.added,
            renamed: report.renamed,
            retired: report.retired,
          },
        });
      }
      report.rolesChanged = changed.size;
      if (report.unknown.length) {
        this.logger.warn(
          `tenant ${tenantId}: permissions in the database but not in code, left untouched: ${report.unknown.join(', ')}`,
        );
      }
      return report;
    });
  }

  /** `old → new`: assignments and the catalog entry move as they are. */
  private async applyRenames(
    tx: TenantTxClient,
    tenantId: string,
    report: TenantSyncReport,
    changed: Set<string>,
  ) {
    for (const [from, to] of Object.entries(this.catalog.renamed)) {
      const assigned = await tx.rolePermission.findMany({
        where: { permission: from },
      });
      const offered = await tx.tenantPermissionCatalog.findUnique({
        where: { tenantId_permission: { tenantId, permission: from } },
      });
      if (!assigned.length && !offered) continue;

      for (const { roleId } of assigned) {
        await tx.rolePermission.createMany({
          data: [{ tenantId, roleId, permission: to }],
          skipDuplicates: true,
        });
        changed.add(roleId);
      }
      await tx.rolePermission.deleteMany({ where: { permission: from } });
      if (offered) {
        await tx.tenantPermissionCatalog.createMany({
          data: [
            { tenantId, permission: to, firstSeenAt: offered.firstSeenAt },
          ],
          skipDuplicates: true,
        });
        await tx.tenantPermissionCatalog.delete({
          where: { tenantId_permission: { tenantId, permission: from } },
        });
      }
      report.renamed.push(`${from}->${to}`);
    }
  }

  private async applyRetirements(
    tx: TenantTxClient,
    report: TenantSyncReport,
    changed: Set<string>,
  ) {
    if (!this.catalog.retired.length) return;
    const where = { permission: { in: [...this.catalog.retired] } };
    const assigned = await tx.rolePermission.findMany({ where });
    const offered = await tx.tenantPermissionCatalog.findMany({ where });
    for (const a of assigned) changed.add(a.roleId);
    await tx.rolePermission.deleteMany({ where });
    await tx.tenantPermissionCatalog.deleteMany({ where });
    report.retired = [
      ...new Set([...assigned, ...offered].map((r) => r.permission)),
    ].sort();
  }

  /** Never-offered permissions go to the default roles that include them. */
  private async applyAdditions(
    tx: TenantTxClient,
    tenantId: string,
    report: TenantSyncReport,
    changed: Set<string>,
  ) {
    const offered = new Set(
      (await tx.tenantPermissionCatalog.findMany()).map((c) => c.permission),
    );
    const fresh = Object.keys(this.catalog.permissions).filter(
      (p) => !offered.has(p),
    );
    if (!fresh.length) return;

    const systemRoles = await tx.role.findMany({ where: { isSystem: true } });
    for (const permission of fresh) {
      for (const def of this.catalog.defaultRoles) {
        if (!def.permissions.includes(permission)) continue;
        const role = systemRoles.find((r) => r.key === def.key);
        if (!role) continue;
        const { count } = await tx.rolePermission.createMany({
          data: [{ tenantId, roleId: role.id, permission }],
          skipDuplicates: true,
        });
        if (count) changed.add(role.id);
      }
      await tx.tenantPermissionCatalog.create({
        data: { tenantId, permission },
      });
      report.added.push(permission);
    }
  }

  private async reportUnknown(tx: TenantTxClient, report: TenantSyncReport) {
    const known = new Set([
      ...Object.keys(this.catalog.permissions),
      ...this.catalog.retired,
      ...Object.keys(this.catalog.renamed),
    ]);
    const inDb = new Set([
      ...(await tx.tenantPermissionCatalog.findMany()).map((c) => c.permission),
      ...(
        await tx.rolePermission.findMany({ select: { permission: true } })
      ).map((r) => r.permission),
    ]);
    report.unknown = [...inDb].filter((p) => !known.has(p)).sort();
  }
}
