import { Injectable } from '@nestjs/common';
import type { AccountType } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { TenantContextMissingError } from '../errors';
import type { AppClsStore } from './app-cls';

/** Typed, fail-fast access to the authenticated request context. */
@Injectable()
export class RequestContext {
  constructor(private readonly cls: ClsService<AppClsStore>) {}

  get tenantId(): string {
    const id = this.cls.isActive() ? this.cls.get('tenantId') : undefined;
    if (!id) throw new TenantContextMissingError();
    return id;
  }

  /**
   * The tenant of the running TenantTx transaction: set for requests and for
   * system work (a sweep, a platform action) alike, where `tenantId` only
   * exists for requests.
   */
  get txTenantId(): string {
    const id = this.cls.isActive() ? this.cls.get('txTenantId') : undefined;
    if (!id) throw new TenantContextMissingError();
    return id;
  }

  get accountId(): string {
    const id = this.cls.isActive() ? this.cls.get('accountId') : undefined;
    if (!id) throw new TenantContextMissingError();
    return id;
  }

  /** The acting account, or null outside a signed-in request (system work). */
  accountIdOrNull(): string | null {
    return (
      (this.cls.isActive() ? this.cls.get('accountId') : undefined) ?? null
    );
  }

  /** The session behind the request's access token (`sid`), or null. */
  sessionIdOrNull(): string | null {
    return (
      (this.cls.isActive() ? this.cls.get('sessionId') : undefined) ?? null
    );
  }

  get accountType(): AccountType {
    const type = this.cls.isActive() ? this.cls.get('accountType') : undefined;
    if (!type) throw new TenantContextMissingError();
    return type;
  }
}
