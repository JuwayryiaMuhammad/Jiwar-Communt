import { randomBytes } from 'node:crypto';
import type { Response } from 'supertest';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../src/core/config/env.schema';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { CredentialVault } from '../../src/finance/gateway/credential-vault';
import {
  GatewayKeys,
  gatewayBootProblems,
} from '../../src/finance/gateway/gateway-keys';
import { auditReaders } from '../setup/audit';
import {
  financeHelpers,
  gatewayBody,
  type FinanceSetUp,
} from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { leakText } from '../setup/leak-text';

const code = (res: Response) => (res.body as { code: string }).code;

interface GatewayBody {
  configured: boolean;
  mode: string | null;
  last4: Record<string, string | null> | null;
  onlineEnabled: boolean;
  platformDisabled: boolean;
  available: boolean;
  updatedBy: string | null;
}

/**
 * A compound's online payment account (ADR 0046): credentials sealed and
 * shown by their last four characters, changed only after a step-up, by
 * the manager or the platform; the platform's switch wins.
 */
describe('Finance — gateway', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;
  let s: FinanceSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
    s = await f.setUp('Gateway Court');
  });

  afterAll(() => h.close());

  const get = (token: string) => f.http('get', '/staff/finance/gateway', token);
  const put = (token: string, body: object) =>
    f.http('put', '/staff/finance/gateway', token, body);
  const patch = (token: string, body: object) =>
    f.http('patch', '/staff/finance/gateway', token, body);

  it('starts unconfigured and off', async () => {
    const c = await f.setUp('Gateway Fresh');
    const res = await get(c.manager.token).expect(200);
    expect(res.body).toEqual({
      configured: false,
      mode: null,
      last4: null,
      onlineEnabled: false,
      platformDisabled: false,
      available: false,
      updatedBy: null,
      updatedAt: null,
    });
  });

  it('a change needs a step-up, spent once; a refused change leaves it usable', async () => {
    const c = await f.setUp('Gateway Step');
    const body = gatewayBody();
    expect(code(await put(c.manager.token, body).expect(403))).toBe(
      'STEP_UP_REQUIRED',
    );
    await f.stepUp(c.manager.token);
    // A mode mismatch is refused, and the step-up is still there.
    const mismatch = await put(c.manager.token, {
      ...body,
      mode: 'live',
    }).expect(400);
    expect((mismatch.body as { fields: unknown }).fields).toEqual([
      { field: 'secretKey', code: 'GATEWAY_MODE_MISMATCH' },
      { field: 'publicKey', code: 'GATEWAY_MODE_MISMATCH' },
    ]);
    await put(c.manager.token, body).expect(200);
    expect(code(await put(c.manager.token, body).expect(403))).toBe(
      'STEP_UP_REQUIRED',
    );
    expect(
      code(await patch(c.manager.token, { onlineEnabled: true }).expect(403)),
    ).toBe('STEP_UP_REQUIRED');
  });

  it('stores the credentials sealed, shows the last four characters only', async () => {
    const body = gatewayBody();
    await f.stepUp(s.manager.token);
    const res = await put(s.manager.token, body).expect(200);
    expect(res.body as GatewayBody).toMatchObject({
      configured: true,
      mode: 'sandbox',
      last4: {
        secretKey: body.secretKey.slice(-4),
        publicKey: body.publicKey.slice(-4),
        hmacSecret: body.hmacSecret.slice(-4),
        cardIntegrationId: '0001',
        walletIntegrationId: '0002',
      },
      onlineEnabled: false,
      available: false,
      updatedBy: 'manager',
    });
    const text = JSON.stringify(res.body);
    for (const secret of [body.secretKey, body.publicKey, body.hmacSecret])
      expect(text).not.toContain(secret);

    const row = await f.x.asManager(s.c, () =>
      h.moduleRef.get(TenantTx).withTenantTx(
        (tx) =>
          tx.$queryRaw<Record<string, unknown>[]>`
          SELECT * FROM finance_gateways WHERE tenant_id = ${s.c.tenantId}::uuid`,
      ),
    );
    const dump = JSON.stringify(row, (_, v: unknown) =>
      v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v,
    );
    for (const secret of [body.secretKey, body.publicKey, body.hmacSecret])
      expect(dump).not.toContain(secret);
    expect(dump).not.toContain('4100001');
  });

  it('online payment needs credentials; on, it is available', async () => {
    const c = await f.setUp('Gateway Toggle');
    await f.stepUp(c.manager.token);
    expect(
      code(await patch(c.manager.token, { onlineEnabled: true }).expect(409)),
    ).toBe('GATEWAY_NOT_CONFIGURED');
    await f.configureGateway(c.manager);
    expect((await get(c.manager.token).expect(200)).body).toMatchObject({
      onlineEnabled: true,
      available: true,
    });
    await f.stepUp(c.manager.token);
    await patch(c.manager.token, { onlineEnabled: false }).expect(200);
    expect((await get(c.manager.token).expect(200)).body).toMatchObject({
      onlineEnabled: false,
      available: false,
    });
  });

  it('the accountant never sees or changes the gateway', async () => {
    await get(s.accountant.token).expect(403);
    await put(s.accountant.token, gatewayBody()).expect(403);
  });

  it('the audit names the fields that changed and the mode, never a value', async () => {
    const c = await f.setUp('Gateway Audit');
    const first = await f.configureGateway(c.manager, {}, false);
    await f.stepUp(c.manager.token);
    await put(c.manager.token, {
      ...first,
      hmacSecret: `HMAC${randomBytes(16).toString('hex')}`,
      walletIntegrationId: null,
    }).expect(200);
    await f.stepUp(c.manager.token);
    await patch(c.manager.token, { onlineEnabled: true }).expect(200);
    const rows = (await auditReaders(h).tenant(c.c.tenantId)).filter((r) =>
      r.action.startsWith('finance_gateway.'),
    );
    expect(rows.map((r) => [r.action, r.metadata])).toEqual([
      [
        'finance_gateway.set',
        {
          fieldsChanged: [
            'secretKey',
            'publicKey',
            'hmacSecret',
            'cardIntegrationId',
            'walletIntegrationId',
          ],
          mode: 'sandbox',
        },
      ],
      [
        'finance_gateway.set',
        {
          fieldsChanged: ['hmacSecret', 'walletIntegrationId'],
          mode: 'sandbox',
        },
      ],
      ['finance_gateway.toggled', { onlineEnabled: true }],
    ]);
    expect(leakText(rows)).not.toContain(first.secretKey.slice(-4));
  });

  describe('the platform', () => {
    const path = (id: string) => `/platform/tenants/${id}/payment-gateway`;

    it('sees any compound masked, sets its credentials and switches it off, after a platform step-up', async () => {
      const c = await f.setUp('Gateway Platform');
      const admin = await f.platformAdmin();
      expect(
        (await f.http('get', path(c.c.tenantId), admin.token).expect(200)).body,
      ).toMatchObject({ configured: false });
      const body = gatewayBody({ walletIntegrationId: null });
      expect(
        code(
          await f
            .http('put', path(c.c.tenantId), admin.token, body)
            .expect(403),
        ),
      ).toBe('STEP_UP_REQUIRED');
      await f.platformStepUp(admin.token);
      const set = await f
        .http('put', path(c.c.tenantId), admin.token, body)
        .expect(200);
      expect(set.body).toMatchObject({
        configured: true,
        updatedBy: 'platform',
        last4: { walletIntegrationId: null },
      });

      // The manager turns it on; the platform's switch wins.
      await f.stepUp(c.manager.token);
      await patch(c.manager.token, { onlineEnabled: true }).expect(200);
      await f.platformStepUp(admin.token);
      await f
        .http('patch', path(c.c.tenantId), admin.token, {
          platformDisabled: true,
        })
        .expect(200);
      expect((await get(c.manager.token).expect(200)).body).toMatchObject({
        onlineEnabled: true,
        platformDisabled: true,
        available: false,
      });
      // The manager cannot lift it.
      await f.stepUp(c.manager.token);
      await patch(c.manager.token, {
        onlineEnabled: true,
        platformDisabled: false,
      }).expect(400);

      const audit = (
        await auditReaders(h).platform({ targetTenantId: c.c.tenantId })
      ).filter((r) => r.action.startsWith('tenant.payment_gateway_'));
      expect(audit.map((r) => [r.action, r.metadata])).toEqual([
        [
          'tenant.payment_gateway_set',
          {
            fieldsChanged: [
              'secretKey',
              'publicKey',
              'hmacSecret',
              'cardIntegrationId',
              'walletIntegrationId',
            ],
            mode: 'sandbox',
          },
        ],
        ['tenant.payment_gateway_toggled', { platformDisabled: true }],
      ]);
    });

    it('an unknown compound is not found', async () => {
      const admin = await f.platformAdmin(true);
      const res = await f
        .http(
          'put',
          path('0190a1b2-0000-7000-8000-00000000dead'),
          admin.token,
          gatewayBody(),
        )
        .expect(404);
      expect(code(res)).toBe('TENANT_NOT_FOUND');
    });
  });

  describe('the keys (boot check and rotation)', () => {
    it('the rule: nothing enabled is fine; enabled needs the key, the webhook origin and the key of its version', () => {
      const base = {
        keyPresent: true,
        webhookBase: 'https://x.test',
        canOpen: (v: number) => v === 1,
      };
      expect(gatewayBootProblems({ ...base, enabled: [] })).toEqual([]);
      expect(
        gatewayBootProblems({
          enabled: [],
          keyPresent: false,
          webhookBase: undefined,
          canOpen: () => false,
        }),
      ).toEqual([]);
      const enabled = [{ tenantId: 't-1', keyVersion: 1 }];
      expect(gatewayBootProblems({ ...base, enabled })).toEqual([]);
      expect(
        gatewayBootProblems({ ...base, enabled, keyPresent: false }).join(),
      ).toMatch(/PAYMENT_CREDENTIALS_KEY is not set.*t-1/);
      expect(
        gatewayBootProblems({
          ...base,
          enabled,
          webhookBase: undefined,
        }).join(),
      ).toMatch(/PAYMENT_WEBHOOK_BASE_URL is not set.*t-1/);
      expect(
        gatewayBootProblems({
          ...base,
          enabled: [{ tenantId: 't-2', keyVersion: 2 }],
        }).join(),
      ).toMatch(/no key for version\(s\) 2.*t-2/);
    });

    it('the check reads every compound that takes online payment and passes with the test key', async () => {
      const c = await f.setUp('Gateway Boot');
      await f.configureGateway(c.manager);
      const keys = h.moduleRef.get(GatewayKeys);
      expect(await keys.enabledGateways()).toContainEqual({
        tenantId: c.c.tenantId,
        keyVersion: 1,
      });
      await keys.check();
      // The same database without a key: the app would not start.
      const keyless = new GatewayKeys(
        {
          get: (k: keyof Env) =>
            k === 'PAYMENT_WEBHOOK_BASE_URL' ? 'https://x.test' : undefined,
        } as unknown as ConfigService<Env, true>,
        h.moduleRef.get(GlobalDbService),
        h.moduleRef.get(TenantTx),
        new CredentialVault({
          get: (k: keyof Env) =>
            k === 'PAYMENT_CREDENTIALS_KEY_VERSION' ? 1 : undefined,
        } as unknown as ConfigService<Env, true>),
      );
      await expect(keyless.check()).rejects.toThrow(
        new RegExp(`PAYMENT_CREDENTIALS_KEY is not set.*${c.c.tenantId}`),
      );
    });

    it('re-sealing moves every gateway to the current key, once, and back', async () => {
      const c = await f.setUp('Gateway Rotate');
      const body = await f.configureGateway(c.manager);
      const config = h.moduleRef.get(ConfigService<Env, true>);
      const testKey = config.get('PAYMENT_CREDENTIALS_KEY', { infer: true })!;
      const newKey = randomBytes(32).toString('base64');
      const vaultFor = (env: Partial<Env>) =>
        new CredentialVault({
          get: (k: keyof Env) => env[k],
        } as unknown as ConfigService<Env, true>);
      const keysFor = (vault: CredentialVault) =>
        new GatewayKeys(
          config,
          h.moduleRef.get(GlobalDbService),
          h.moduleRef.get(TenantTx),
          vault,
        );
      const rotated = vaultFor({
        PAYMENT_CREDENTIALS_KEY: newKey,
        PAYMENT_CREDENTIALS_KEY_VERSION: 2,
        PAYMENT_CREDENTIALS_PREVIOUS_KEYS: `1:${testKey}`,
      });
      const back = vaultFor({
        PAYMENT_CREDENTIALS_KEY: testKey,
        PAYMENT_CREDENTIALS_KEY_VERSION: 1,
        PAYMENT_CREDENTIALS_PREVIOUS_KEYS: `2:${newKey}`,
      });
      try {
        expect(await keysFor(rotated).reencryptAll()).toBeGreaterThan(0);
        expect(await keysFor(rotated).reencryptAll()).toBe(0);
        const row = await f.x.asManager(c.c, () =>
          h.moduleRef.get(TenantTx).withTenantTx((tx) =>
            tx.financeGateway.findUniqueOrThrow({
              where: { tenantId: c.c.tenantId },
            }),
          ),
        );
        expect(row.keyVersion).toBe(2);
        expect(
          rotated.open(c.c.tenantId, 'secret_key', row.secretKeyEnc, 2),
        ).toBe(body.secretKey);
      } finally {
        // Every compound of the test database back under the test key.
        await keysFor(back).reencryptAll();
      }
      expect((await get(c.manager.token).expect(200)).body).toMatchObject({
        available: true,
      });
    });
  });
});
