import 'dotenv/config';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import {
  ACCESS_CATALOG,
  CODE_ACCESS_CATALOG,
  catalogProblems,
} from '../access/access-catalog';
import { RoleLifecycle } from '../access/role-lifecycle';
import { AuditModule } from '../audit/audit.module';
import { validateEnv } from '../config/env.schema';
import { DatabaseModule } from '../database/database.module';
import { PermissionSyncService } from './permission-sync.service';

/**
 * `pnpm access:sync` locally; `node dist/platform/access-sync.cli.js` on
 * deploy, AFTER `prisma migrate deploy` and BEFORE starting the server
 * (ADR 0010). Exits non-zero on an inconsistent catalog or any failure.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      validate: validateEnv,
    }),
    ClsModule.forRoot({ global: true }),
    DatabaseModule,
    AuditModule,
  ],
  providers: [
    { provide: ACCESS_CATALOG, useValue: CODE_ACCESS_CATALOG },
    PermissionSyncService,
    // This process boots core only: no domain registers a handler here.
    RoleLifecycle,
  ],
})
class AccessSyncCliModule {}

async function main(): Promise<void> {
  const problems = catalogProblems(CODE_ACCESS_CATALOG);
  if (problems.length) {
    throw new Error(
      `Inconsistent permission catalog:\n- ${problems.join('\n- ')}`,
    );
  }
  const app = await NestFactory.createApplicationContext(AccessSyncCliModule, {
    logger: ['error', 'warn'],
  });
  try {
    const reports = await app.get(PermissionSyncService).syncAll();
    const changed = reports.filter(
      (r) => r.added.length || r.renamed.length || r.retired.length,
    );
    console.log(
      `access:sync: ${reports.length} compound(s), ${changed.length} changed.`,
    );
    for (const r of changed) {
      console.log(
        `  ${r.tenantId}: roles created [${r.rolesCreated.join(', ')}] added [${r.added.join(', ')}] renamed [${r.renamed.join(', ')}] retired [${r.retired.join(', ')}]`,
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
