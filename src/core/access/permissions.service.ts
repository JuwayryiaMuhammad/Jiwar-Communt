import { Inject, Injectable } from '@nestjs/common';
import type { AccountType } from '@prisma/client';
import Redis from 'ioredis';
import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../common/cls/app-cls';
import { TenantContextMissingError } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { REDIS } from '../redis/redis.module';
import { ACCESS_CATALOG, type AccessCatalog } from './access-catalog';
import { DerivedGrants, isDerived } from './derived-grants';
import type { Permission } from './permissions';

/** Only for cleanup: a key is correct forever because it includes the version. */
const CACHE_TTL_SECONDS = 3600;

/**
 * Resolves role permissions (ADR 0010). Never stored in the JWT.
 *
 * Cache key: `perm:{tenantId}:{roleId}:{permissionsVersion}`. Every change to
 * a role's permissions bumps the version in the same transaction, so an entry
 * is never invalidated — it simply stops being read. A request that loaded
 * the old permissions and writes them to the cache after an edit writes them
 * under the old version, which nothing asks for again.
 *
 * A grant the role's kind may not hold (the permission's `kinds` were
 * narrowed in code after it was made) never counts: it is dropped on every
 * read, cached or not, so it stops working with the deploy and not only once
 * `access:sync` has revoked it.
 */
@Injectable()
export class PermissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<AppClsStore>,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ACCESS_CATALOG) private readonly catalog: AccessCatalog,
    private readonly derived: DerivedGrants,
  ) {}

  /** Permissions of the current account's role, as set by PermissionsGuard. */
  async current(): Promise<ReadonlySet<string>> {
    const tenantId = this.cls.isActive() ? this.cls.get('tenantId') : undefined;
    const roleId = this.cls.get('roleId');
    const version = this.cls.get('permissionsVersion');
    const kind = this.cls.get('accountType');
    if (!tenantId || !roleId || version === undefined || !kind) {
      throw new TenantContextMissingError();
    }
    return this.forRole(tenantId, roleId, version, kind);
  }

  /** The role's permissions, or a derived one the account holds now. */
  async has(permission: Permission): Promise<boolean> {
    if (isDerived(permission)) {
      const accountId = this.cls.get('accountId');
      if (!accountId) throw new TenantContextMissingError();
      return this.derived.holds(permission, accountId);
    }
    return (await this.current()).has(permission);
  }

  /**
   * `tenantId` must be the request tenant: the lookup runs under RLS. `kind`
   * is the account's (its role's kind, by the foreign key).
   */
  async forRole(
    tenantId: string,
    roleId: string,
    version: number,
    kind: AccountType,
  ): Promise<ReadonlySet<string>> {
    const cached = await this.redis.get(cacheKey(tenantId, roleId, version));
    if (cached) return this.assignable(JSON.parse(cached) as string[], kind);

    // Version and permissions from one snapshot of the role; cached under the
    // version actually read, which may be newer than the one asked for.
    const role = await this.prisma.tenant.role.findUnique({
      where: { id: roleId },
      select: {
        permissionsVersion: true,
        permissions: { select: { permission: true } },
      },
    });
    if (!role) return new Set();
    const permissions = role.permissions.map((p) => p.permission).sort();
    await this.redis.set(
      cacheKey(tenantId, roleId, role.permissionsVersion),
      JSON.stringify(permissions),
      'EX',
      CACHE_TTL_SECONDS,
    );
    return this.assignable(permissions, kind);
  }

  /** Without the grants `kind` may not hold; one unknown to code is kept. */
  private assignable(permissions: string[], kind: AccountType) {
    return new Set(
      permissions.filter((p) => {
        const def = this.catalog.permissions[p];
        return !def || def.kinds.includes(kind);
      }),
    );
  }
}

export function cacheKey(
  tenantId: string,
  roleId: string,
  version: number,
): string {
  return `perm:${tenantId}:${roleId}:${version}`;
}
