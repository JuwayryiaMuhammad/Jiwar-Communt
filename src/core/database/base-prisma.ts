import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

// ============================================================================
// The base client. Private to src/database/ (enforced by ESLint).
// ============================================================================
//
// It connects as jiwar_app, so RLS always applies, but it knows nothing about
// the request tenant: a query through it sees no tenant rows at all (fail
// closed). Everything outside this folder reaches the database through
// PrismaService.tenant, TenantTx or GlobalDbService.

export const BASE_PRISMA = Symbol('BASE_PRISMA');

export interface BasePrisma {
  client: PrismaClient;
  pool: Pool;
}

export function createBasePrisma(
  connectionString: string,
  poolMax: number,
): BasePrisma {
  const pool = new Pool({ connectionString, max: poolMax });
  const client = new PrismaClient({
    adapter: new PrismaPg(pool),
    transactionOptions: { maxWait: 5_000, timeout: 10_000 },
  });
  return { client, pool };
}
