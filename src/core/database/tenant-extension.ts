import { PrismaClient } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../common/cls/app-cls';
import {
  TenantClientMisuseError,
  TenantContextMissingError,
} from '../common/errors';

/**
 * Members removed from the tenant client. `$transaction` would run each inner
 * query in its own batch transaction (deadlock on a pool of one, and outside
 * the outer transaction on a bigger pool). Raw SQL is not covered by the
 * per-model hook. Both go through TenantTx.withTenantTx instead.
 */
const FORBIDDEN = [
  '$transaction',
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
  '$connect',
  '$disconnect',
  '$extends',
  '$on',
] as const;

type Forbidden = (typeof FORBIDDEN)[number];

function extend(base: PrismaClient, cls: ClsService<AppClsStore>) {
  return base.$extends({
    name: 'tenant-rls',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (cls.isActive() && cls.get('inTenantTx')) {
            throw new TenantClientMisuseError(
              `PrismaService.tenant.${model}.${operation} was called inside withTenantTx; use the tx argument`,
            );
          }
          const tenantId = cls.isActive() ? cls.get('tenantId') : undefined;
          if (!tenantId) throw new TenantContextMissingError();

          // set_config(..., true) is transaction-local: it dies with this
          // batch transaction and can never follow the pooled connection
          // into another request.
          const [, result] = await base.$transaction([
            base.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
            query(args),
          ]);
          return result;
        },
      },
    },
  });
}

export type TenantClient = Omit<ReturnType<typeof extend>, Forbidden>;

export function createTenantClient(
  base: PrismaClient,
  cls: ClsService<AppClsStore>,
): TenantClient {
  const extended = extend(base, cls);
  const forbidden = new Set<string | symbol>(FORBIDDEN);
  return new Proxy(extended, {
    get(target, prop, receiver) {
      if (forbidden.has(prop)) {
        return () => {
          throw new TenantClientMisuseError(
            `PrismaService.tenant.${String(prop)} is not available; use TenantTx.withTenantTx`,
          );
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}
