import type { Server } from 'node:http';
import type { INestApplication, Type } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import type { AccountType } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import type { AccessTokenClaims } from '../../src/core/common/guards/access-token';
import { newId } from '../../src/core/common/uuid';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { TenantsService } from '../../src/core/platform/tenants.service';
import { nationalIdFor, uniquePhone, uniqueSuffix } from './fixtures';

export const API = '/api/v1';

export interface HttpHarness {
  app: INestApplication;
  moduleRef: TestingModule;
  http: () => TestAgent;
  createTenant(name: string): Promise<{ id: string; name: string }>;
  createAccount(
    tenantId: string,
    input: {
      type: AccountType;
      email: string;
      phone: string;
      fullName?: string;
    },
  ): Promise<{ id: string }>;
  /** Marks the compound suspended (the platform service arrives later). */
  suspendTenant(tenantId: string): Promise<void>;
  /** A valid access token minted directly (skips the OTP flow), with its session. */
  tokenFor(claims: Omit<AccessTokenClaims, 'sid'>): Promise<string>;
  close(): Promise<void>;
}

/** The full AppModule, configured exactly like main.ts, without listening. */
export async function createHttpHarness(
  opts: { controllers?: Type[]; imports?: Type[] } = {},
): Promise<HttpHarness> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, ...(opts.imports ?? [])],
    // Test-only controllers, e.g. to exercise a guard before its routes exist.
    controllers: opts.controllers ?? [],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();

  const globalDb = moduleRef.get(GlobalDbService);
  const accounts = moduleRef.get(AccountsService);
  const cls = moduleRef.get<ClsService<AppClsStore>>(ClsService);
  const jwt = moduleRef.get(JwtService);
  const tenantTx = moduleRef.get(TenantTx);
  const tenants = moduleRef.get(TenantsService);

  return {
    app,
    moduleRef,
    http: () => request(app.getHttpServer() as Server),
    // The row and everything a real compound gets (roles, settings, the
    // domains' defaults through TenantLifecycle), in one transaction, the
    // way TenantsService creates one; without its first manager or the
    // platform audit entry, which each test adds as it needs.
    async createTenant(name) {
      const tenant = { id: newId(), name: `${name} ${uniqueSuffix()}` };
      await cls.run(async () => {
        cls.set('tenantId', tenant.id);
        await tenantTx.withTenantTx(async (tx) => {
          await globalDb.in(tx).tenant.create({ data: tenant });
          await tenants.provision(tx, tenant.id);
        });
      });
      return tenant;
    },
    // Through the real service, as a manager of that tenant would.
    createAccount: (tenantId, input) =>
      cls.run(async () => {
        cls.set('tenantId', tenantId);
        cls.set('accountId', newId());
        cls.set('accountType', 'manager');
        return await accounts.create({
          type: input.type,
          fullName: input.fullName ?? `Person ${uniqueSuffix()}`,
          idDocumentType: 'national_id' as const,
          idDocumentNumber: nationalIdFor(),
          phone: input.phone,
          email: input.email,
        });
      }),
    async suspendTenant(tenantId) {
      await globalDb.tenant.update({
        where: { id: tenantId },
        data: { status: 'suspended' },
      });
    },
    // A real session row backs every token: the guard checks it per request.
    async tokenFor(claims) {
      const sid = newId();
      await globalDb.session.create({
        data: {
          id: sid,
          accountId: claims.sub,
          tenantId: claims.tid,
          refreshTokenHash: '0'.repeat(64),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      return jwt.signAsync({ ...claims, sid } satisfies AccessTokenClaims, {
        expiresIn: 900,
        audience: 'tenant',
      });
    },
    close: () => app.close(),
  };
}

export { uniquePhone };

export function uniqueEmail(label = 'user'): string {
  return `${label}-${uniqueSuffix()}@example.test`;
}
