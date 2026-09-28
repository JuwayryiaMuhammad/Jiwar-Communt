import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ApiBearerAuth } from '@nestjs/swagger';
import { isUUID } from 'class-validator';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../common/cls/app-cls';
import { appError, ErrorCode } from '../common/errors';
import {
  PLATFORM_ROUTE_KEY,
  type PlatformRouteOptions,
} from '../common/guards/platform-route.decorator';
import { GlobalDbService } from '../database/global-db.service';
import { PLATFORM_JWT } from './platform-jwt';
import type { PlatformTokenClaims } from './platform-policy';
import { PlatformSessionService } from './platform-session.service';

/**
 * Authenticates platform (super admin) routes, and only them (ADR 0011).
 * Accepts only platform tokens: a tenant token fails the signature and the
 * audience check. On every request the admin must still be active and, for a
 * full token, its session still live — revocation applies immediately.
 */
@Injectable()
export class PlatformAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PLATFORM_JWT) private readonly jwt: JwtService,
    private readonly cls: ClsService<AppClsStore>,
    private readonly globalDb: GlobalDbService,
    private readonly sessions: PlatformSessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options =
      this.reflector.getAllAndOverride<PlatformRouteOptions | undefined>(
        PLATFORM_ROUTE_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? {};

    const req = context.switchToHttp().getRequest<Request>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw unauthenticated();

    let claims: PlatformTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<PlatformTokenClaims>(token);
    } catch {
      throw unauthenticated();
    }
    if (
      !isUUID(claims.sub) ||
      (claims.scp !== 'full' && claims.scp !== 'password_change')
    ) {
      throw unauthenticated();
    }

    const admin = await this.globalDb.platformAdmin.findUnique({
      where: { id: claims.sub },
      select: { status: true, mustChangePassword: true },
    });
    if (!admin || admin.status !== 'active') throw unauthenticated();

    if (claims.scp === 'password_change') {
      if (!admin.mustChangePassword) throw unauthenticated(); // already used
      if (!options.allowPasswordChange) {
        throw appError.forbidden(
          ErrorCode.PASSWORD_CHANGE_REQUIRED,
          'Change the password before doing anything else',
        );
      }
    } else if (
      admin.mustChangePassword ||
      !claims.sid ||
      !(await this.sessions.isLive(claims.sid))
    ) {
      throw unauthenticated();
    }

    this.cls.set('platformAdminId', claims.sub);
    this.cls.set('platformScope', claims.scp);
    return true;
  }
}

/**
 * Marks a route as a platform route: the tenant guards skip it and
 * PlatformAuthGuard authenticates it.
 */
export function PlatformAuth(options: PlatformRouteOptions = {}) {
  return applyDecorators(
    SetMetadata(PLATFORM_ROUTE_KEY, options),
    UseGuards(PlatformAuthGuard),
    ApiBearerAuth(),
  );
}

function unauthenticated() {
  return appError.unauthorized(
    ErrorCode.UNAUTHENTICATED,
    'Authentication required',
  );
}
