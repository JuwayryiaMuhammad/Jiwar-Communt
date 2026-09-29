import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { isUUID } from 'class-validator';
import type { AppClsStore } from '../cls/app-cls';
import { appError, ErrorCode } from '../errors';
import { ACCOUNT_TYPES, type AccessTokenClaims } from './access-token';
import { PLATFORM_ROUTE_KEY } from './platform-route.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Global guard. Verifies the bearer access token and puts tenant, account and
 * account type into the request context — the only place the tenant for
 * database access comes from (ADR 0005).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_KEY,
      targets,
    );
    // Platform routes are authenticated by PlatformAuthGuard instead; this
    // guard never accepts platform tokens (different secret and audience).
    const isPlatform = this.reflector.getAllAndOverride<unknown>(
      PLATFORM_ROUTE_KEY,
      targets,
    );
    if (isPublic || isPlatform) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw unauthenticated();

    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        algorithms: ['HS256'],
        audience: 'tenant',
      });
    } catch {
      throw unauthenticated();
    }
    if (
      !isUUID(claims.sub) ||
      !isUUID(claims.tid) ||
      !isUUID(claims.sid) ||
      !ACCOUNT_TYPES.includes(claims.typ)
    ) {
      throw unauthenticated();
    }

    this.cls.set('tenantId', claims.tid);
    this.cls.set('accountId', claims.sub);
    this.cls.set('accountType', claims.typ);
    this.cls.set('sessionId', claims.sid);
    return true;
  }
}

function unauthenticated() {
  return appError.unauthorized(
    ErrorCode.UNAUTHENTICATED,
    'Authentication required',
  );
}
