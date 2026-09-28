import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../common/cls/app-cls';
import { TenantContextMissingError } from '../common/errors';
import { PrismaService } from '../database/prisma.service';
import { REDIS } from '../redis/redis.module';
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
 */
@Injectable()
export class PermissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<AppClsStore>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Permissions of the current account's role, as set by PermissionsGuard. */
  async current(): Promise<ReadonlySet<string>> {
    const tenantId = this.cls.isActive() ? this.cls.get('tenantId') : undefined;
    const roleId = this.cls.get('roleId');
    const version = this.cls.get('permissionsVersion');
    if (!tenantId || !roleId || version === undefined) {
      throw new TenantContextMissingError();
    }
    return this.forRole(tenantId, roleId, version);
  }

  async has(permission: Permission): Promise<boolean> {
    return (await this.current()).has(permission);
  }

  /** `tenantId` must be the request tenant: the lookup runs under RLS. */
  async forRole(
    tenantId: string,
    roleId: string,
    version: number,
  ): Promise<ReadonlySet<string>> {
    const cached = await this.redis.get(cacheKey(tenantId, roleId, version));
    if (cached) return new Set(JSON.parse(cached) as string[]);

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
    return new Set(permissions);
  }
}

export function cacheKey(
  tenantId: string,
  roleId: string,
  version: number,
): string {
  return `perm:${tenantId}:${roleId}:${version}`;
}
