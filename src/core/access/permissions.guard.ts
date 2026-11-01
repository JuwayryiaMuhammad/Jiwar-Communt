import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../common/cls/app-cls';
import { appError, ErrorCode } from '../common/errors';
import { PLATFORM_ROUTE_KEY } from '../common/guards/platform-route.decorator';
import { IS_PUBLIC_KEY } from '../common/guards/public.decorator';
import { GlobalDbService } from '../database/global-db.service';
import { PrismaService } from '../database/prisma.service';
import { DerivedGrants, isDerived } from './derived-grants';
import { PermissionsService } from './permissions.service';
import type { Permission } from './permissions';
import {
  ANY_PERMISSIONS_KEY,
  REQUIRED_PERMISSIONS_KEY,
} from './require-permissions.decorator';

/**
 * Global guard after JwtAuthGuard, on every tenant-authenticated route:
 *
 * 1. loads the account with its role version and its compound's status, in
 *    one RLS-scoped query, and the token's session — an inactive account, a
 *    suspended compound or a revoked session is rejected now, not when the
 *    access token expires (ADR 0004);
 * 2. puts the role and its permissions version in the request context;
 * 3. reads the account's live deputyship (ADR 0073): what it gained as a
 *    deputy, and what it gave away as a principal;
 * 4. checks `@RequirePermissions(...)` (all of them) or
 *    `@RequireAnyPermission(...)` (at least one) (ADR 0010). A derived
 *    permission (ADR 0051) is asked of its check, only when the role does
 *    not settle it. A route allowed only through a gained permission is
 *    recorded on the principal's behalf.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService<AppClsStore>,
    private readonly prisma: PrismaService,
    private readonly globalDb: GlobalDbService,
    private readonly permissions: PermissionsService,
    private readonly derived: DerivedGrants,
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
        // Until when the account has a deputyship, either side (ADR 0073):
        // only then are its deputyships read.
        deputyUntil: true,
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
    // A live deputyship (ADR 0073): what this account gained, or gave
    // away. Most accounts have none, and pay nothing for it.
    const delegation =
      account.deputyUntil && account.deputyUntil > new Date()
        ? await this.permissions.delegationOf(accountId)
        : { gained: [], principalId: null, away: [] };
    this.cls.set('delegation', delegation);

    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(
      REQUIRED_PERMISSIONS_KEY,
      targets,
    );
    const anyOf = this.reflector.getAllAndOverride<Permission[] | undefined>(
      ANY_PERMISSIONS_KEY,
      targets,
    );
    if (!required?.length && !anyOf?.length) return true;

    const role = await this.permissions.forRole(
      tenantId,
      account.roleId,
      account.role.permissionsVersion,
      account.type,
    );
    const granted = this.permissions.withDelegation(
      role,
      delegation,
      account.type,
    );
    const allowed = (set: ReadonlySet<string>) =>
      (required?.length && required.every((p) => set.has(p))) ||
      (anyOf?.length && anyOf.some((p) => set.has(p)));
    if (allowed(granted)) {
      // Through a gained permission only: on the principal's behalf.
      const own = this.permissions.withDelegation(
        role,
        { gained: [], away: delegation.away },
        account.type,
      );
      if (delegation.principalId && !allowed(own))
        this.cls.set('onBehalfOf', delegation.principalId);
      return true;
    }
    // Only now the derived ones: a request the role settles costs nothing.
    const holds = (p: Permission) =>
      granted.has(p) ||
      (isDerived(p) ? this.derived.holds(p, accountId) : false);
    if (required?.length && required.some(isDerived)) {
      let all = true;
      for (const p of required) if (!(await holds(p))) all = false;
      if (all) return true;
    }
    if (anyOf?.length && anyOf.some(isDerived)) {
      for (const p of anyOf) if (await holds(p)) return true;
    }
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
