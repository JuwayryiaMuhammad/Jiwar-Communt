import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AccountType } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../cls/app-cls';
import { appError, ErrorCode } from '../errors';
import { ROLES_KEY } from './roles.decorator';

/** Role layer (ADR 0001). Runs after JwtAuthGuard has filled the context. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<AccountType[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!allowed?.length) return true;

    const type = this.cls.get('accountType');
    if (type && allowed.includes(type)) return true;
    throw appError.forbidden(
      ErrorCode.FORBIDDEN,
      'Not allowed for this account type',
    );
  }
}
