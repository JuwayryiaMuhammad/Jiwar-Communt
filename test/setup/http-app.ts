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
import { RoleProvisioner } from '../../src/core/access/role-provisioner';
import { uniqueSuffix } from './fixtures';

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
  /** A valid access token minted directly (skips the OTP flow). */
  tokenFor(claims: AccessTokenClaims): Promise<string>;
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
  const provisioner = moduleRef.get(RoleProvisioner);

  return {
    app,
    moduleRef,
    http: () => request(app.getHttpServer() as Server),
    async createTenant(name) {
      const tenant = { id: newId(), name: `${name} ${uniqueSuffix()}` };
      await globalDb.tenant.create({ data: tenant });
      await cls.run(async () => {
        cls.set('tenantId', tenant.id);
        await tenantTx.withTenantTx((tx) =>
          provisioner.provision(tx, tenant.id),
        );
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
          nationalId: `29001010${Math.floor(Math.random() * 1e6)
            .toString()
            .padStart(6, '0')}`,
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
    tokenFor: (claims) =>
      jwt.signAsync(claims, { expiresIn: 900, audience: 'tenant' }),
    close: () => app.close(),
  };
}

/** A fresh, valid Egyptian mobile number in E.164. */
export function uniquePhone(): string {
  return `+2010${Math.floor(Math.random() * 1e8)
    .toString()
    .padStart(8, '0')}`;
}

export function uniqueEmail(label = 'user'): string {
  return `${label}-${uniqueSuffix()}@example.test`;
}
