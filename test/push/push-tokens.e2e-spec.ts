import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { Notifier } from '../../src/core/notifications/notifier';
import { TenantsService } from '../../src/core/platform/tenants.service';
import { PUSH_DEVICE_LIMIT } from '../../src/core/push/push-devices.service';
import { auditReaders } from '../setup/audit';
import { communityHelpers, type Compound } from '../setup/community';
import { eraseNow } from '../setup/erasure';
import { buildExports, readArchive, stepUp } from '../setup/exports';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { loginViaOtp } from '../setup/login';
import {
  drainPush,
  FakePushTransport,
  INSTALL_1,
  INSTALL_2,
  pushToken,
  registerPush,
  removePush,
} from '../setup/push';
import { required } from '../setup/test-env';

const installNo = (n: number) =>
  `0192a5f0-1c2b-7d3e-8f40-${String(n).padStart(12, '0')}`;

/**
 * Push tokens (ADR 0041): one per account and install, bound to the session
 * that registered it, and gone the moment that session, or the account's
 * right to one, ends. The token itself is in `push_devices.token` and
 * nowhere else.
 */
describe('Push tokens (ADR 0041)', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let globalDb: GlobalDbService;
  let c: Compound;
  let db: Client;
  const fake = new FakePushTransport();

  beforeAll(async () => {
    h = await createHttpHarness({ push: fake });
    x = communityHelpers(h);
    globalDb = h.moduleRef.get(GlobalDbService);
    c = await x.compound('Push Token Court');
    db = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await db.connect();
  }, 120_000);

  afterAll(async () => {
    await db.end();
    await h.close();
  });

  beforeEach(async () => {
    fake.reset();
    await globalDb.pushDelivery.deleteMany({});
  });

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** A tenant beside the unit's owner: not a primary, so it can be erased. */
  async function someone(compound: Compound = c) {
    const unit = await x.unit(compound);
    await x.resident(compound, [unit.id]);
    const p = await x.resident(compound, [unit.id], 'tenant');
    const token = await h.tokenFor({
      sub: p.id,
      tid: compound.tenantId,
      typ: 'resident',
    });
    return { ...p, token };
  }

  const devices = (accountId: string) =>
    globalDb.pushDevice.findMany({
      where: { accountId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  const managerToken = (compound: Compound = c) =>
    h.tokenFor({
      sub: compound.managerId,
      tid: compound.tenantId,
      typ: 'manager',
    });

  const notify = (accountId: string) =>
    x.asManager(c, () =>
      h.moduleRef.get(TenantTx).withTenantTx((tx) =>
        h.moduleRef.get(Notifier).notify(tx, [accountId], {
          kind: 'data_export.ready',
          params: { expiresAt: '2026-10-20T09:00:00.000Z' },
          targetId: accountId,
        }),
      ),
    );

  // --------------------------------------------------------------------------
  describe('registering', () => {
    it('stores one row for the account and install, bound to the session; answers nothing', async () => {
      const p = await someone();
      const token = pushToken();
      const res = await registerPush(h, p.token, {
        token,
        platform: 'ios',
      }).expect(204);
      expect(res.text).toBe('');

      const [row, ...rest] = await devices(p.id);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        tenantId: c.tenantId,
        accountId: p.id,
        platform: 'ios',
        token,
      });
      expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      // The install id is kept as a keyed hash only.
      expect(row.installHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(INSTALL_1);
      const session = await globalDb.session.findUniqueOrThrow({
        where: { id: row.sessionId },
      });
      expect(session).toMatchObject({ accountId: p.id, revokedAt: null });
    });

    it('registering again from the same install replaces the token', async () => {
      const p = await someone();
      const first = pushToken();
      const second = pushToken();
      await registerPush(h, p.token, { token: first }).expect(204);
      const [before] = await devices(p.id);
      await registerPush(h, p.token, {
        token: second,
        platform: 'ios',
      }).expect(204);
      // The same token again: a no-op the app may repeat at every start.
      await registerPush(h, p.token, {
        token: second,
        platform: 'ios',
      }).expect(204);
      const rows = await devices(p.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: before.id,
        token: second,
        platform: 'ios',
      });
    });

    it('another install is another row; the install id is case-insensitive', async () => {
      const p = await someone();
      await registerPush(h, p.token, { token: pushToken() }).expect(204);
      await registerPush(h, p.token, { token: pushToken() }, INSTALL_2).expect(
        204,
      );
      await registerPush(
        h,
        p.token,
        { token: pushToken() },
        INSTALL_2.toUpperCase(),
      ).expect(204);
      expect(await devices(p.id)).toHaveLength(2);
    });

    it('needs the install id: INSTALL_ID_REQUIRED without it, or with one that is not a UUID', async () => {
      const p = await someone();
      for (const install of [null, 'my-phone']) {
        const res = await registerPush(
          h,
          p.token,
          { token: pushToken() },
          install,
        ).expect(400);
        expect((res.body as { code: string }).code).toBe('INSTALL_ID_REQUIRED');
        const gone = await removePush(h, p.token, install).expect(400);
        expect((gone.body as { code: string }).code).toBe(
          'INSTALL_ID_REQUIRED',
        );
      }
      expect(await devices(p.id)).toEqual([]);
    });

    it('a rejected body never echoes the token', async () => {
      const p = await someone();
      const token = pushToken();
      const res = await registerPush(h, p.token, {
        token,
        platform: 'windows' as 'ios',
      }).expect(400);
      expect(res.text).not.toContain(token);
    });

    it('a token is on one row only: an install that signs in to another account takes it along, across compounds', async () => {
      const a = await someone();
      const b = await someone();
      const other = await x.compound('Push Token Court B');
      const far = await someone(other);
      const token = pushToken();

      await registerPush(h, a.token, { token }).expect(204);
      await registerPush(h, b.token, { token }).expect(204);
      expect(await devices(a.id)).toEqual([]);
      expect(await devices(b.id)).toHaveLength(1);

      await registerPush(h, far.token, { token }).expect(204);
      expect(await devices(b.id)).toEqual([]);
      expect(await devices(far.id)).toMatchObject([
        { tenantId: other.tenantId, token },
      ]);
      expect(await globalDb.pushDevice.count({ where: { token } })).toBe(1);
    });

    it('two accounts registering the same token at once leave one row', async () => {
      for (let round = 0; round < 3; round++) {
        const a = await someone();
        const b = await someone();
        const token = pushToken();
        const results = await Promise.all([
          registerPush(h, a.token, { token }),
          registerPush(h, b.token, { token }),
        ]);
        expect(results.map((r) => r.status)).toEqual([204, 204]);
        expect(await globalDb.pushDevice.count({ where: { token } })).toBe(1);
      }
    });

    it(`keeps ${PUSH_DEVICE_LIMIT} installs: one more drops the least recently used`, async () => {
      const p = await someone();
      for (let i = 1; i <= PUSH_DEVICE_LIMIT; i++) {
        await registerPush(
          h,
          p.token,
          { token: pushToken() },
          installNo(i),
        ).expect(204);
      }
      const full = await devices(p.id);
      expect(full).toHaveLength(PUSH_DEVICE_LIMIT);
      // The first one registered is used again: the second is now the oldest.
      await globalDb.pushDevice.update({
        where: { id: full[0].id },
        data: { lastUsedAt: new Date(Date.now() + 1000) },
      });
      await globalDb.pushDevice.update({
        where: { id: full[1].id },
        data: { lastUsedAt: new Date(Date.now() - 60_000) },
      });
      await registerPush(
        h,
        p.token,
        { token: pushToken() },
        installNo(99),
      ).expect(204);
      const after = await devices(p.id);
      expect(after).toHaveLength(PUSH_DEVICE_LIMIT);
      expect(after.map((d) => d.id)).toContain(full[0].id);
      expect(after.map((d) => d.id)).not.toContain(full[1].id);
    });

    it('DELETE removes this install only, and may be repeated', async () => {
      const p = await someone();
      await registerPush(h, p.token, { token: pushToken() }).expect(204);
      const kept = pushToken();
      await registerPush(h, p.token, { token: kept }, INSTALL_2).expect(204);
      const res = await removePush(h, p.token).expect(204);
      expect(res.text).toBe('');
      await removePush(h, p.token).expect(204);
      expect(await devices(p.id)).toMatchObject([{ token: kept }]);
    });

    it('is not audited: no audit entry and no security event for a register or a delete', async () => {
      const p = await someone();
      const read = auditReaders(h);
      const before = {
        audit: (await read.tenant(c.tenantId)).length,
        security: (await read.security({ accountId: p.id })).length,
      };
      await registerPush(h, p.token, { token: pushToken() }).expect(204);
      await removePush(h, p.token).expect(204);
      expect({
        audit: (await read.tenant(c.tenantId)).length,
        security: (await read.security({ accountId: p.id })).length,
      }).toEqual(before);
    });
  });

  // --------------------------------------------------------------------------
  describe('what ends a token', () => {
    it('logout removes the token of that session, not the other phone’s', async () => {
      const p = await someone();
      const phone1 = await loginViaOtp(h, p.email, p.id);
      const phone2 = await loginViaOtp(h, p.email, p.id);
      const kept = pushToken();
      await registerPush(h, phone1.accessToken, {
        token: pushToken(),
      }).expect(204);
      await registerPush(
        h,
        phone2.accessToken,
        { token: kept },
        INSTALL_2,
      ).expect(204);

      await h
        .http()
        .post(`${API}/auth/logout`)
        .send({ refreshToken: phone1.refreshToken })
        .expect(204);
      expect(await devices(p.id)).toMatchObject([{ token: kept }]);

      // Nothing is pushed to the phone that logged out.
      await notify(p.id);
      await drainPush(h);
      expect(fake.sent.map((m) => m.token)).toEqual([kept]);
    });

    it('a refresh keeps the token (same session); a replayed refresh token ends both', async () => {
      const p = await someone();
      const first = await loginViaOtp(h, p.email, p.id);
      await registerPush(h, first.accessToken, {
        token: pushToken(),
      }).expect(204);
      await h
        .http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: first.refreshToken })
        .expect(200);
      expect(await devices(p.id)).toHaveLength(1);

      // The rotated token comes back: the session is presumed stolen.
      await h
        .http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: first.refreshToken })
        .expect(401);
      expect(await devices(p.id)).toEqual([]);
    });

    it('revoking one session removes its token only', async () => {
      const p = await someone();
      const other = await h.tokenFor({
        sub: p.id,
        tid: c.tenantId,
        typ: 'resident',
      });
      const kept = pushToken();
      await registerPush(h, p.token, { token: kept }).expect(204);
      await registerPush(h, other, { token: pushToken() }, INSTALL_2).expect(
        204,
      );
      const doomed = (await devices(p.id)).find((d) => d.token !== kept)!;

      await h
        .http()
        .post(`${API}/me/sessions/${doomed.sessionId}/revoke`)
        .set(bearer(p.token))
        .send({})
        .expect(204);
      expect(await devices(p.id)).toMatchObject([{ token: kept }]);
    });

    it('"that wasn\'t me": revoking every session removes every token, and the old access token registers nothing', async () => {
      const p = await someone();
      await registerPush(h, p.token, { token: pushToken() }).expect(204);
      await registerPush(h, p.token, { token: pushToken() }, INSTALL_2).expect(
        204,
      );
      await h
        .http()
        .post(`${API}/me/sessions/revoke-all`)
        .set(bearer(p.token))
        .send({})
        .expect(200);
      expect(await devices(p.id)).toEqual([]);
      await registerPush(h, p.token, { token: pushToken() }).expect(401);
      expect(await devices(p.id)).toEqual([]);
    });

    it('deactivation and freeze remove every token', async () => {
      const inactive = await someone();
      await registerPush(h, inactive.token, { token: pushToken() }).expect(204);
      await h
        .http()
        .patch(`${API}/accounts/${inactive.id}/status`)
        .set(bearer(await managerToken()))
        .send({ status: 'inactive' })
        .expect(200);
      expect(await devices(inactive.id)).toEqual([]);

      const frozen = await someone();
      await registerPush(h, frozen.token, { token: pushToken() }).expect(204);
      await x.asManager(c, () =>
        h.moduleRef
          .get(AccountsService)
          .freeze(frozen.id, { code: 'phone_reassigned', text: 'Reported' }),
      );
      expect(await devices(frozen.id)).toEqual([]);
    });

    it('erasure deletes the tokens and what was queued for them', async () => {
      const p = await someone();
      await registerPush(h, p.token, { token: pushToken() }).expect(204);
      const [device] = await devices(p.id);
      await notify(p.id);
      expect(
        await globalDb.pushDelivery.count({ where: { deviceId: device.id } }),
      ).toBe(1);

      await eraseNow(h, c, p.id);
      expect(await devices(p.id)).toEqual([]);
      expect(
        await globalDb.pushDelivery.count({ where: { deviceId: device.id } }),
      ).toBe(0);
      await drainPush(h);
      expect(fake.sent).toEqual([]);
    });

    it('a suspended compound loses every token; another compound keeps its own', async () => {
      const doomed = await x.compound('Push Suspended Court');
      const there = await someone(doomed);
      const here = await someone();
      await registerPush(h, there.token, { token: pushToken() }).expect(204);
      await registerPush(h, here.token, { token: pushToken() }).expect(204);
      await h.moduleRef
        .get(TenantsService)
        .setStatus(doomed.tenantId, 'suspended');
      expect(await devices(there.id)).toEqual([]);
      expect(await devices(here.id)).toHaveLength(1);
    });

    it('a logout racing a registration never leaves a token behind an ended session', async () => {
      for (let round = 0; round < 3; round++) {
        const p = await someone();
        const phone = await loginViaOtp(h, p.email, p.id);
        const [registered] = await Promise.all([
          registerPush(h, phone.accessToken, { token: pushToken() }),
          h
            .http()
            .post(`${API}/auth/logout`)
            .send({ refreshToken: phone.refreshToken })
            .expect(204),
        ]);
        // Either it landed first and the logout deleted it, or it lost.
        expect([204, 401]).toContain(registered.status);
        expect(await devices(p.id)).toEqual([]);
      }
    });

    it('revoke-all racing a registration leaves no token either', async () => {
      for (let round = 0; round < 3; round++) {
        const p = await someone();
        const [registered] = await Promise.all([
          registerPush(h, p.token, { token: pushToken() }),
          h
            .http()
            .post(`${API}/me/sessions/revoke-all`)
            .set(bearer(p.token))
            .send({}),
        ]);
        expect([204, 401]).toContain(registered.status);
        expect(await devices(p.id)).toEqual([]);
      }
    });
  });

  // --------------------------------------------------------------------------
  describe('the token is a secret', () => {
    it('the export lists the devices by platform and dates, never the token', async () => {
      const unit = await x.unit(c);
      const p = await x.resident(c, [unit.id]);
      const access = await h.tokenFor({
        sub: p.id,
        tid: c.tenantId,
        typ: 'resident',
      });
      const token = pushToken();
      await registerPush(h, access, { token, platform: 'ios' }).expect(204);
      const [device] = await devices(p.id);

      await stepUp(h, access, p.email);
      const asked = await h
        .http()
        .post(`${API}/me/data-exports`)
        .set(bearer(access))
        .send({})
        .expect(201);
      await buildExports(h);
      const dl = await h
        .http()
        .get(
          `${API}/me/data-exports/${(asked.body as { id: string }).id}/download`,
        )
        .set(bearer(access))
        .expect(200);
      const archive = await readArchive((dl.body as { url: string }).url);

      expect(archive.names).toContain('push-devices.json');
      expect(JSON.parse(archive.text('push-devices.json'))).toEqual([
        {
          id: device.id,
          platform: 'ios',
          createdAt: device.createdAt.toISOString(),
          lastUsedAt: device.lastUsedAt.toISOString(),
        },
      ]);
      expect(
        (JSON.parse(archive.text('README.json')) as { sections: string[] })
          .sections,
      ).toContain('push_devices');
      expect(archive.all).not.toContain(token);
      expect(archive.all).not.toContain(device.tokenHash);
    });

    it('is in push_devices.token and in no other column of any table, no log line and no response', async () => {
      const logged: string[] = [];
      for (const level of ['log', 'error', 'warn', 'debug', 'verbose'] as const)
        jest
          .spyOn(Logger.prototype, level)
          .mockImplementation((...args: unknown[]) => {
            logged.push(JSON.stringify(args));
          });
      const responses: string[] = [];
      try {
        const p = await someone();
        const dead = pushToken('dead');
        const live = pushToken('live');
        responses.push(
          (await registerPush(h, p.token, { token: dead }).expect(204)).text,
          (
            await registerPush(h, p.token, { token: live }, INSTALL_2).expect(
              204,
            )
          ).text,
        );
        // Sent, retried, refused and removed: every path a token travels.
        await notify(p.id);
        fake.failToken(dead, {
          ok: false,
          kind: 'token',
          code: 'UNREGISTERED',
        });
        fake.next({ ok: false, kind: 'transient', code: 'UNAVAILABLE' });
        await drainPush(h);
        await drainPush(h, new Date(Date.now() + 3600_000));
        expect(fake.to(live).length).toBeGreaterThan(0);
        for (const path of ['/me', '/me/sessions', '/me/notifications']) {
          responses.push(
            (
              await h
                .http()
                .get(`${API}${path}`)
                .set(bearer(p.token))
                .expect(200)
            ).text,
          );
        }
        responses.push((await removePush(h, p.token, INSTALL_2)).text);
        // One more, still registered, for the table scan.
        const kept = pushToken('kept');
        await registerPush(h, p.token, { token: kept }).expect(204);

        const tables = (
          await db.query(
            `SELECT table_name FROM information_schema.tables
              WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
          )
        ).rows as { table_name: string }[];
        expect(tables.length).toBeGreaterThan(40);
        for (const secret of [dead, live, kept]) {
          for (const { table_name: t } of tables) {
            // push_devices is read without its token column.
            const row =
              t === 'push_devices'
                ? `(to_jsonb(x) - 'token')::text`
                : 'x::text';
            const hits = await db.query(
              `SELECT count(*) FROM "${t}" x WHERE ${row} LIKE $1`,
              [`%${secret}%`],
            );
            expect({
              table: t,
              hits: Number((hits.rows[0] as { count: string }).count),
            }).toEqual({ table: t, hits: 0 });
          }
          expect(logged.join('\n')).not.toContain(secret);
          expect(responses.join('\n')).not.toContain(secret);
        }
        expect(
          await globalDb.pushDevice.count({ where: { token: kept } }),
        ).toBe(1);
      } finally {
        jest.restoreAllMocks();
      }
    });
  });
});
