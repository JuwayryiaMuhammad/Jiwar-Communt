import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../common/cls/app-cls';
import { appError, ErrorCode } from '../common/errors';
import { PLATFORM_ROUTE_KEY } from '../common/guards/platform-route.decorator';
import { IS_PUBLIC_KEY } from '../common/guards/public.decorator';
import { GlobalDbService } from '../database/global-db.service';
import { PrismaService } from '../database/prisma.service';
import { PermissionsService } from './permissions.service';
import type { Permission } from './permissions';
import { REQUIRED_PERMISSIONS_KEY } from './require-permissions.decorator';

/**
 * Global guard after JwtAuthGuard, on every tenant-authenticated route:
 *
 * 1. loads the account with its role version and its compound's status, in
 *    one RLS-scoped query, and the token's session — an inactive account, a
 *    suspended compound or a revoked session is rejected now, not when the
 *    access token expires (ADR 0004);
 * 2. puts the role and its permissions version in the request context;
 * 3. checks `@RequirePermissions(...)` (ADR 0010).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService<AppClsStore>,
    private readonly prisma: PrismaService,
    private readonly globalDb: GlobalDbService,
    private readonly permissions: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) ||
      this.reflector.getAllAndOverride<unknown>(PLATFORM_ROUTE_KEY, targets)
    ) {
      return true;
    }

    const tenantId = this.cls.get('tenantId');
    const accountId = this.cls.get('accountId');
    const sessionId = this.cls.get('sessionId');
    if (!tenantId || !accountId || !sessionId) throw unauthenticated();

    const session = await this.globalDb.session.findUnique({
      where: { id: sessionId },
      select: {
        accountId: true,
        tenantId: true,
        revokedAt: true,
        expiresAt: true,
      },
    });
    if (
      !session ||
      session.accountId !== accountId ||
      session.tenantId !== tenantId ||
      session.revokedAt !== null ||
      session.expiresAt <= new Date()
    ) {
      throw unauthenticated();
    }

    const account = await this.prisma.tenant.account.findUnique({
      where: { id: accountId },
      select: {
        status: true,
        type: true,
        roleId: true,
        role: { select: { permissionsVersion: true } },
        tenant: { select: { status: true } },
      },
    });
    if (
      !account ||
      account.status !== 'active' ||
      account.tenant.status !== 'active'
    ) {
      throw unauthenticated();
    }
    // Capacity from the database, not from the token claim.
    this.cls.set('accountType', account.type);
    this.cls.set('roleId', account.roleId);
    this.cls.set('permissionsVersion', account.role.permissionsVersion);

    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(
      REQUIRED_PERMISSIONS_KEY,
      targets,
    );
    if (!required?.length) return true;

    const granted = await this.permissions.forRole(
      tenantId,
      account.roleId,
      account.role.permissionsVersion,
    );
    if (required.every((p) => granted.has(p))) return true;
    throw appError.forbidden(
      ErrorCode.FORBIDDEN,
      'Missing permission for this action',
    );
  }
}

function unauthenticated() {
  return appError.unauthorized(
    ErrorCode.UNAUTHENTICATED,
    'Authentication required',
  );
}
