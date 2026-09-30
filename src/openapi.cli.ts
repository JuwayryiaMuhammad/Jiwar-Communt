import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { API_PREFIX, buildOpenApiDocument } from './app.setup';
import { stableJson } from './core/common/http/stable-json';

export const OPENAPI_FILE = 'docs/api/openapi.v0.json';

/**
 * `pnpm openapi:export`: writes the API contract without starting anything.
 * Preview mode builds the module graph and routes but instantiates no
 * provider, so no database, Redis or SMTP is needed.
 */
async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
    abortOnError: false,
  });
  app.setGlobalPrefix(API_PREFIX);
  const file = resolve(process.cwd(), OPENAPI_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, stableJson(buildOpenApiDocument(app)));
  await app.close();
  console.log(`Wrote ${OPENAPI_FILE}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
