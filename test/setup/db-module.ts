import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../../src/common/cls/app-cls';
import { validateEnv } from '../../src/config/env.schema';
import { DatabaseModule } from '../../src/database/database.module';
import { GlobalDbService } from '../../src/database/global-db.service';
import { PrismaService } from '../../src/database/prisma.service';
import { TenantTx } from '../../src/database/tenant-tx.service';

export interface DbHarness {
  moduleRef: TestingModule;
  cls: ClsService<AppClsStore>;
  prisma: PrismaService;
  tenantTx: TenantTx;
  globalDb: GlobalDbService;
  /** Runs `fn` with `tenantId` in the request context, as JwtAuthGuard would. */
  asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Just config + CLS + the database layer, with an optional pool size. */
export async function createDbHarness(
  opts: { poolMax?: number } = {},
): Promise<DbHarness> {
  const previousPoolMax = process.env.DB_POOL_MAX;
  if (opts.poolMax !== undefined)
    process.env.DB_POOL_MAX = String(opts.poolMax);
  try {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validate: validateEnv,
        }),
        ClsModule.forRoot({ global: true }),
        DatabaseModule,
      ],
    }).compile();
    await moduleRef.init();

    const cls = moduleRef.get<ClsService<AppClsStore>>(ClsService);
    return {
      moduleRef,
      cls,
      prisma: moduleRef.get(PrismaService),
      tenantTx: moduleRef.get(TenantTx),
      globalDb: moduleRef.get(GlobalDbService),
      // `await` inside run() matters: Prisma queries are lazy and execute on
      // then(), so an un-awaited query would run after the context is gone.
      asTenant: (tenantId, fn) =>
        cls.run(async () => {
          cls.set('tenantId', tenantId);
          return await fn();
        }),
      close: () => moduleRef.close(),
    };
  } finally {
    if (previousPoolMax === undefined) delete process.env.DB_POOL_MAX;
    else process.env.DB_POOL_MAX = previousPoolMax;
  }
}
