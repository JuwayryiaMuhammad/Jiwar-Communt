import 'dotenv/config';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { validateEnv } from '../../core/config/env.schema';
import { DatabaseModule } from '../../core/database/database.module';
import { CredentialVault } from './credential-vault';
import { GatewayKeys } from './gateway-keys';

/**
 * `pnpm finance:reencrypt-gateways` (ADR 0046), during a key rotation:
 * set the new PAYMENT_CREDENTIALS_KEY and _KEY_VERSION, move the old key to
 * PAYMENT_CREDENTIALS_PREVIOUS_KEYS, deploy, run this, then drop the old
 * key. Re-seals every compound's gateway with the current key; running it
 * again changes nothing. Exits non-zero on any failure.
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
  ],
  providers: [CredentialVault, GatewayKeys],
})
class ReencryptCliModule {}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(ReencryptCliModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    await app.get(GatewayKeys).reencryptAll();
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
