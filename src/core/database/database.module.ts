import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { BASE_PRISMA, createBasePrisma, type BasePrisma } from './base-prisma';
import { GlobalDbService } from './global-db.service';
import { PrismaService } from './prisma.service';
import { TenantTx } from './tenant-tx.service';

/**
 * Exports the three sanctioned access paths. BASE_PRISMA stays internal.
 */
@Global()
@Module({
  providers: [
    {
      provide: BASE_PRISMA,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): BasePrisma =>
        createBasePrisma(
          config.get('DATABASE_URL', { infer: true }),
          config.get('DB_POOL_MAX', { infer: true }),
        ),
    },
    PrismaService,
    TenantTx,
    GlobalDbService,
  ],
  exports: [PrismaService, TenantTx, GlobalDbService],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(BASE_PRISMA) private readonly base: BasePrisma) {}

  async onApplicationShutdown(): Promise<void> {
    await this.base.client.$disconnect();
    await this.base.pool.end();
  }
}
