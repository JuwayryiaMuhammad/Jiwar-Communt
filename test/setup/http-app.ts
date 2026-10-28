import { PAYMOB_TRANSPORT } from '../../src/finance/paymob/paymob-transport';
import { FakePaymob } from './paymob-fake';
import type { Server } from 'node:http';
import type { INestApplication, Type } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import type { CREATABLE_ACCOUNT_TYPES } from '../../src/core/accounts/dto/create-account.dto';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import type { AccessTokenClaims } from '../../src/core/common/guards/access-token';
import { newId } from '../../src/core/common/uuid';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { TenantsService } from '../../src/core/platform/tenants.service';
import {
  PUSH_TRANSPORT,
  type PushTransport,
} from '../../src/core/push/push-transport';
import { syncDbClock } from './compound-clock';
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
      /** What a manager creates; a proxy comes only from its invite. */
      type: (typeof CREATABLE_ACCOUNT_TYPES)[number];
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

/**
 * The full AppModule, configured exactly like main.ts, listening once on a
 * free local port. supertest given a server that is not listening listens it
 * for each request and adds three `once` listeners per request still waiting
 * (more than ten in a race: MaxListenersExceededWarning), then closes it and
 * listens again on another port. A listening server is only addressed.
 */
export async function createHttpHarness(
  opts: {
    /**
     * False for a caller that listens on its own port (the web smoke's
     * fixed one): a server listens once.
     */
    listen?: boolean;
    controllers?: Type[];
    imports?: Type[];
    /**
     * Turns push on with this transport (ADR 0041). Without it push is off,
     * as on a server with no FCM settings: nothing is queued or sent.
     */
    push?: PushTransport;
    /**
     * Paymob (ADR 0046): always a fake, so no suite ever reaches Paymob;
     * pass one to script it and read what was sent.
     */
    paymob?: FakePaymob;
  } = {},
): Promise<HttpHarness> {
  const builder = Test.createTestingModule({
    imports: [AppModule, ...(opts.imports ?? [])],
    // Test-only controllers, e.g. to exercise a guard before its routes exist.
    controllers: opts.controllers ?? [],
  });
  if (opts.push) builder.overrideProvider(PUSH_TRANSPORT).useValue(opts.push);
  builder
    .overrideProvider(PAYMOB_TRANSPORT)
    .useValue(opts.paymob ?? new FakePaymob());
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();
  if (opts.listen ?? true) await app.listen(0, '127.0.0.1');

  const globalDb = moduleRef.get(GlobalDbService);
  const accounts = moduleRef.get(AccountsService);
  const cls = moduleRef.get<ClsService<AppClsStore>>(ClsService);
  const jwt = moduleRef.get(JwtService);
  const tenantTx = moduleRef.get(TenantTx);
  const tenants = moduleRef.get(TenantsService);
  await syncDbClock(globalDb);

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
          // eslint-disable-next-line no-restricted-syntax -- a real 24 h: the session's TTL is in ms
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
