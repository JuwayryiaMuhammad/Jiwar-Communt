import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsString } from 'class-validator';
import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { hashPassword, verifyPassword } from '../../src/core/platform/password';
import { PlatformAuth } from '../../src/core/platform/platform-auth.guard';
import { PlatformAuthService } from '../../src/core/platform/platform-auth.service';
import { PlatformBootstrapService } from '../../src/core/platform/platform-bootstrap.service';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { newId } from '../../src/core/common/uuid';
import { uniqueSuffix } from '../setup/fixtures';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';

class ChangePasswordBody {
  @IsString() currentPassword: string;
  @IsString() newPassword: string;
}

/** Test-only routes: platform endpoints come with the design. */
@Controller('probe')
class ProbeController {
  constructor(
    private readonly cls: ClsService<AppClsStore>,
    private readonly auth: PlatformAuthService,
  ) {}

  @PlatformAuth()
  @Get('platform')
  platform() {
    return {
      adminId: this.cls.get('platformAdminId'),
      scope: this.cls.get('platformScope'),
      tenantId: this.cls.get('tenantId') ?? null,
    };
  }

  @PlatformAuth({ allowPasswordChange: true })
  @Post('change-password')
  changePassword(@Body() body: ChangePasswordBody) {
    return this.auth.changePassword(body.currentPassword, body.newPassword);
  }
}

const PASSWORD = 'initial-password-123';

describe('Platform super admin', () => {
  let h: HttpHarness;
  let auth: PlatformAuthService;
  let bootstrap: PlatformBootstrapService;
  let globalDb: GlobalDbService;

  beforeAll(async () => {
    h = await createHttpHarness({
      controllers: [ProbeController],
      imports: [PlatformModule],
    });
    auth = h.moduleRef.get(PlatformAuthService);
    bootstrap = h.moduleRef.get(PlatformBootstrapService);
    globalDb = h.moduleRef.get(GlobalDbService);
  });

  afterAll(() => h.close());

  async function admin(
    opts: { mustChange?: boolean; status?: 'active' | 'disabled' } = {},
  ) {
    const email = `admin-${uniqueSuffix()}@jiwar.test`;
    const row = await globalDb.platformAdmin.create({
      data: {
        id: newId(),
        email,
        passwordHash: await hashPassword(PASSWORD),
        mustChangePassword: opts.mustChange ?? false,
        status: opts.status ?? 'active',
      },
    });
    return { id: row.id, email };
  }

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const probe = (token: string) =>
    h.http().get('/api/v1/probe/platform').set(bearer(token));

  // --------------------------------------------------------------------------
  describe('bootstrap', () => {
    async function clear() {
      await globalDb.platformSession.deleteMany();
      await globalDb.platformAdmin.deleteMany();
    }

    it('creates the admin once, with a forced password change', async () => {
      await clear();
      expect(
        await bootstrap.run({ email: 'Owner@Jiwar.Test', password: PASSWORD }),
      ).toBe('created');
      const created = await globalDb.platformAdmin.findUniqueOrThrow({
        where: { email: 'owner@jiwar.test' },
      });
      expect(created.mustChangePassword).toBe(true);
      expect(created.passwordHash).toMatch(/^\$argon2id\$/);
    });

    it('never overwrites an existing admin from the environment', async () => {
      const before = await globalDb.platformAdmin.findUniqueOrThrow({
        where: { email: 'owner@jiwar.test' },
      });
      expect(
        await bootstrap.run({
          email: 'owner@jiwar.test',
          password: 'a-different-password',
        }),
      ).toBe('exists');
      expect(
        await bootstrap.run({ email: 'other@jiwar.test', password: PASSWORD }),
      ).toBe('exists');
      const after = await globalDb.platformAdmin.findUniqueOrThrow({
        where: { email: 'owner@jiwar.test' },
      });
      expect(after.passwordHash).toBe(before.passwordHash);
      expect(await globalDb.platformAdmin.count()).toBe(1);
      expect(await verifyPassword(after.passwordHash, PASSWORD)).toBe(true);
    });

    it('does nothing (and warns) when not configured', async () => {
      await clear();
      expect(await bootstrap.run({})).toBe('not-configured');
      expect(await globalDb.platformAdmin.count()).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  describe('login', () => {
    it('logs in with a full token and a refresh token', async () => {
      const a = await admin();
      const tokens = await auth.login(
        a.email.toUpperCase(),
        PASSWORD,
        '10.0.0.1',
      );
      expect(tokens).toMatchObject({
        scope: 'full',
        refreshToken: expect.any(String) as string,
      });
      const res = await probe(tokens.accessToken).expect(200);
      expect(res.body).toEqual({
        adminId: a.id,
        scope: 'full',
        tenantId: null,
      });
    });

    it('fails the same way for a wrong password, an unknown email and a disabled admin', async () => {
      const a = await admin();
      const disabled = await admin({ status: 'disabled' });
      const attempts = [
        () => auth.login(a.email, 'wrong-password-000', '10.0.0.2'),
        () =>
          auth.login(
            `nobody-${uniqueSuffix()}@jiwar.test`,
            PASSWORD,
            '10.0.0.2',
          ),
        () => auth.login(disabled.email, PASSWORD, '10.0.0.2'),
      ];
      for (const attempt of attempts) {
        await expect(attempt()).rejects.toMatchObject({
          status: 401,
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid credentials',
        });
      }
    });

    it('locks the account after N failures, even for the right password', async () => {
      const a = await admin();
      for (let i = 0; i < 5; i++) {
        await expect(
          auth.login(a.email, 'wrong-password-000', '10.0.0.3'),
        ).rejects.toMatchObject({
          code: 'INVALID_CREDENTIALS',
        });
      }
      await expect(
        auth.login(a.email, PASSWORD, '10.0.0.3'),
      ).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
      });
      const row = await globalDb.platformAdmin.findUniqueOrThrow({
        where: { id: a.id },
      });
      expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

      // Once the lock expires, the right password works again.
      await globalDb.platformAdmin.update({
        where: { id: a.id },
        data: { lockedUntil: new Date(Date.now() - 1000) },
      });
      await expect(
        auth.login(a.email, PASSWORD, '10.0.0.3'),
      ).resolves.toMatchObject({
        scope: 'full',
      });
    });

    it('rate limits per email', async () => {
      const email = `limited-${uniqueSuffix()}@jiwar.test`;
      for (let i = 0; i < 10; i++) {
        await expect(auth.login(email, 'x', '10.0.0.4')).rejects.toMatchObject({
          status: 401,
        });
      }
      await expect(auth.login(email, 'x', '10.0.0.4')).rejects.toMatchObject({
        status: 429,
        code: 'RATE_LIMITED',
      });
    });
  });

  // --------------------------------------------------------------------------
  describe('forced password change', () => {
    it('the restricted token only opens the password-change route', async () => {
      const a = await admin({ mustChange: true });
      const restricted = await auth.login(a.email, PASSWORD, '10.0.1.1');
      expect(restricted).toEqual({
        scope: 'password_change',
        accessToken: expect.any(String) as string,
        accessTokenExpiresIn: expect.any(Number) as number,
      });

      const blocked = await probe(restricted.accessToken).expect(403);
      expect(blocked.body).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
      await expect(auth.refresh('anything.at-all')).rejects.toMatchObject({
        status: 401,
      });

      const changed = await h
        .http()
        .post('/api/v1/probe/change-password')
        .set(bearer(restricted.accessToken))
        .send({
          currentPassword: PASSWORD,
          newPassword: 'a-brand-new-password',
        })
        .expect(201);
      const full = changed.body as { scope: string; accessToken: string };
      expect(full.scope).toBe('full');
      await probe(full.accessToken).expect(200);

      // The restricted token is spent.
      await h
        .http()
        .post('/api/v1/probe/change-password')
        .set(bearer(restricted.accessToken))
        .send({
          currentPassword: 'a-brand-new-password',
          newPassword: 'another-new-password',
        })
        .expect(401);
      await expect(
        auth.login(a.email, 'a-brand-new-password', '10.0.1.1'),
      ).resolves.toMatchObject({
        scope: 'full',
      });
    });

    it('rejects a wrong current password, a short one and an unchanged one', async () => {
      const a = await admin({ mustChange: true });
      const restricted = await auth.login(a.email, PASSWORD, '10.0.1.2');
      const change = (currentPassword: string, newPassword: string) =>
        h
          .http()
          .post('/api/v1/probe/change-password')
          .set(bearer(restricted.accessToken))
          .send({ currentPassword, newPassword });

      expect(
        (await change('wrong-password-000', 'long-enough-password')).body,
      ).toMatchObject({
        code: 'INVALID_CREDENTIALS',
      });
      expect((await change(PASSWORD, 'short')).body).toMatchObject({
        code: 'VALIDATION_FAILED',
        fields: [
          { field: 'newPassword', code: 'INVALID_LENGTH', params: { min: 12 } },
        ],
      });
      expect((await change(PASSWORD, PASSWORD)).body).toMatchObject({
        fields: [{ field: 'newPassword', code: 'SAME_AS_CURRENT' }],
      });
    });

    it('changing the password ends every other session', async () => {
      const a = await admin();
      const first = await auth.login(a.email, PASSWORD, '10.0.1.3');
      const second = await auth.login(a.email, PASSWORD, '10.0.1.3');
      const changed = await h
        .http()
        .post('/api/v1/probe/change-password')
        .set(bearer(second.accessToken))
        .send({
          currentPassword: PASSWORD,
          newPassword: 'rotated-password-456',
        })
        .expect(201);
      await probe(first.accessToken).expect(401);
      await probe(second.accessToken).expect(401);
      await probe((changed.body as { accessToken: string }).accessToken).expect(
        200,
      );
    });
  });

  // --------------------------------------------------------------------------
  describe('sessions', () => {
    it('refresh rotates; replaying the old token revokes the session', async () => {
      const a = await admin();
      const tokens = await auth.login(a.email, PASSWORD, '10.0.2.1');
      if (tokens.scope !== 'full') throw new Error('expected a full login');
      const rotated = await auth.refresh(tokens.refreshToken);
      expect(rotated.refreshToken).not.toBe(tokens.refreshToken);
      await expect(auth.refresh(tokens.refreshToken)).rejects.toMatchObject({
        code: 'REFRESH_TOKEN_INVALID',
      });
      await expect(auth.refresh(rotated.refreshToken)).rejects.toMatchObject({
        status: 401,
      });
      await probe(rotated.accessToken).expect(401);
    });

    it('logout revokes the session and its access token', async () => {
      const a = await admin();
      const tokens = await auth.login(a.email, PASSWORD, '10.0.2.2');
      if (tokens.scope !== 'full') throw new Error('expected a full login');
      await auth.logout(tokens.refreshToken);
      await probe(tokens.accessToken).expect(401);
      await expect(auth.refresh(tokens.refreshToken)).rejects.toMatchObject({
        status: 401,
      });
    });

    it('disabling the admin blocks its live token immediately', async () => {
      const a = await admin();
      const tokens = await auth.login(a.email, PASSWORD, '10.0.2.3');
      await globalDb.platformAdmin.update({
        where: { id: a.id },
        data: { status: 'disabled' },
      });
      await probe(tokens.accessToken).expect(401);
    });
  });

  // --------------------------------------------------------------------------
  describe('token separation', () => {
    it('a platform token is rejected by the tenant routes', async () => {
      const a = await admin();
      const tokens = await auth.login(a.email, PASSWORD, '10.0.3.1');
      const res = await h
        .http()
        .get(`${API}/units`)
        .set(bearer(tokens.accessToken))
        .expect(401);
      expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
      await h
        .http()
        .get(`${API}/me`)
        .set(bearer(tokens.accessToken))
        .expect(401);
    });

    it('a tenant token is rejected by the platform guard', async () => {
      const tenant = await h.createTenant('Compound T');
      const manager = await h.createAccount(tenant.id, {
        type: 'manager',
        email: uniqueEmail('mgr'),
        phone: uniquePhone(),
      });
      const token = await h.tokenFor({
        sub: manager.id,
        tid: tenant.id,
        typ: 'manager',
      });
      await h.http().get(`${API}/units`).set(bearer(token)).expect(200);
      await probe(token).expect(401);
    });
  });
});
