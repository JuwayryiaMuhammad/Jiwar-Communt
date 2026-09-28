import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../common/cls/app-cls';
import {
  TenantClientMisuseError,
  TenantContextMissingError,
} from '../common/errors';
import { BASE_PRISMA, type BasePrisma } from './base-prisma';

export type TenantTxClient = Prisma.TransactionClient;

/**
 * Multi-statement units of work and raw SQL, inside one interactive
 * transaction whose first statement sets the tenant (ADR 0005).
 */
@Injectable()
export class TenantTx {
  private readonly logger = new Logger(TenantTx.name);

  constructor(
    @Inject(BASE_PRISMA) private readonly base: BasePrisma,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  /** Runs `fn` in a transaction scoped to the request tenant. */
  withTenantTx<T>(fn: (tx: TenantTxClient) => Promise<T>): Promise<T> {
    const tenantId = this.cls.isActive() ? this.cls.get('tenantId') : undefined;
    if (!tenantId) return Promise.reject(new TenantContextMissingError());
    return this.run(tenantId, fn);
  }

  /**
   * Same as withTenantTx, but with a tenant chosen by the caller instead of
   * the request context. This bypasses the one rule that keeps tenants apart,
   * so it is lint-restricted to src/auth/ (the login bootstrap, which has no
   * tenant yet) and prisma/seed.ts. Every call is logged.
   */
  runInTenantUnsafe<T>(
    tenantId: string,
    fn: (tx: TenantTxClient) => Promise<T>,
  ): Promise<T> {
    this.logger.debug(`runInTenantUnsafe tenant=${tenantId}`);
    return this.run(tenantId, fn);
  }

  private run<T>(
    tenantId: string,
    fn: (tx: TenantTxClient) => Promise<T>,
  ): Promise<T> {
    if (this.cls.isActive() && this.cls.get('inTenantTx')) {
      // A second interactive transaction needs a second connection: a
      // deadlock on a pool of one, and not atomic with the outer one anyway.
      return Promise.reject(
        new TenantClientMisuseError(
          'withTenantTx cannot be nested; pass the tx argument down instead',
        ),
      );
    }
    // Awaited inside run(): Prisma promises are lazy, and the callback must
    // execute while the inTenantTx flag is in the context.
    return this.cls.run({ ifNested: 'inherit' }, async () => {
      this.cls.set('inTenantTx', true);
      return await this.base.client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return await fn(tx);
      });
    });
  }
}
