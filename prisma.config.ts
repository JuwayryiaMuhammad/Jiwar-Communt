import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// The Prisma CLI (migrate, db pull, studio) connects as the table owner.
// The running app never reads this file: it connects as jiwar_app through
// DATABASE_URL (src/database/base-prisma.ts). See ADR 0005.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node --transpile-only prisma/seed.ts',
  },
  datasource: {
    url: process.env['MIGRATOR_DATABASE_URL'],
  },
});
