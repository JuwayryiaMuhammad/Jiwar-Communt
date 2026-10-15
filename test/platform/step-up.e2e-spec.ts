import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { newId } from '../../src/core/common/uuid';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { hashPassword } from '../../src/core/platform/password';
import { PlatformSessionService } from '../../src/core/platform/platform-session.service';
import { PlatformStepUpService } from '../../src/core/platform/platform-step-up.service';
import { sessionOf } from '../api/world';
import { auditReaders } from '../setup/audit';
import { codeOf, uniqueSuffix } from '../setup/fixtures';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { waitForMessage, waitForOtp } from '../setup/mailpit';

/**
 * Platform step-up (ADR 0046): a fresh code to the platform admin's own
 * email, bound to the platform session that asked, opening that session's
 * next sensitive action once.
 */
describe('Platform step-up', () => {
  let h: HttpHarness;
  let globalDb: GlobalDbService;

  beforeAll(async () => {
    h = await createHttpHarness();
    globalDb = h.moduleRef.get(GlobalDbService);
  });

  afterAll(() => h.close());

  async function admin() {
    const email = `admin-${uniqueSuffix()}@jiwar.test`;
    const row = await globalDb.platformAdmin.create({
      data: {
        id: newId(),
        email,
        passwordHash: await hashPassword('step-up-password-123'),
        mustChangePassword: false,
      },
    });
    const token = (await h.moduleRef.get(PlatformSessionService).start(row.id))
      .accessToken;
    return { id: row.id, email, token, sessionId: sessionOf(token) };
  }

  const ask = (token: string) =>
    h
      .http()
      .post(`${API}/platform/step-up`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
  const verify = (token: string, code: string) =>
    h
      .http()
      .post(`${API}/platform/step-up/verify`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code });

  /** Spends the session's step-up in a transaction, as an action would. */
  const consume = (a: { id: string; sessionId: string }) =>
    h.moduleRef.get(ClsService<AppClsStore>).run(() => {
      const cls = h.moduleRef.get(ClsService<AppClsStore>);
      cls.set('platformAdminId', a.id);
      cls.set('platformScope', 'full');
      cls.set('platformSessionId', a.sessionId);
      return globalDb.transaction((tx) =>
        h.moduleRef.get(PlatformStepUpService).consume(tx),
      );
    });

  it('emails a code to the admin, and a right code opens the session once', async () => {
    const a = await admin();
    const since = new Date();
    await ask(a.token).expect(202);
    await waitForMessage(a.email, since);
    const code = await waitForOtp(a.email, since);

    expect(await codeOf(consume(a))).toBe('STEP_UP_REQUIRED');
    const wrong = code === '000000' ? '111111' : '000000';
    const refused = await verify(a.token, wrong).expect(403);
    expect((refused.body as { code: string }).code).toBe(
      'STEP_UP_CODE_INVALID',
    );

    const ok = await verify(a.token, code).expect(200);
    const until = new Date((ok.body as { expiresAt: string }).expiresAt);
    expect(Math.abs(until.getTime() - (Date.now() + 10 * 60_000))).toBeLessThan(
      60_000,
    );
    const session = await globalDb.platformSession.findUniqueOrThrow({
      where: { id: a.sessionId },
    });
    expect(session.stepUpUntil).toEqual(until);

    await consume(a);
    expect(await codeOf(consume(a))).toBe('STEP_UP_REQUIRED');
    await verify(a.token, code).expect(403);
  });

  it('is bound to the platform session that asked', async () => {
    const a = await admin();
    const other = (await h.moduleRef.get(PlatformSessionService).start(a.id))
      .accessToken;
    const since = new Date();
    await ask(a.token).expect(202);
    const code = await waitForOtp(a.email, since);
    await verify(other, code).expect(403);
    expect(
      await codeOf(consume({ id: a.id, sessionId: sessionOf(other) })),
    ).toBe('STEP_UP_REQUIRED');
    await verify(a.token, code).expect(200);
  });

  it('a revoked session or an expired step-up opens nothing', async () => {
    const a = await admin();
    await globalDb.platformSession.update({
      where: { id: a.sessionId },
      data: { stepUpUntil: new Date(Date.now() - 1000) },
    });
    expect(await codeOf(consume(a))).toBe('STEP_UP_REQUIRED');
    await globalDb.platformSession.update({
      where: { id: a.sessionId },
      data: {
        stepUpUntil: new Date(Date.now() + 60_000),
        revokedAt: new Date(),
      },
    });
    expect(await codeOf(consume(a))).toBe('STEP_UP_REQUIRED');
  });

  it('a tenant step-up code is no platform step-up code, and the other way round', async () => {
    const a = await admin();
    const since = new Date();
    await ask(a.token).expect(202);
    const code = await waitForOtp(a.email, since);
    // The tenant route refuses a platform token outright.
    await h
      .http()
      .post(`${API}/me/step-up/verify`)
      .set('Authorization', `Bearer ${a.token}`)
      .send({ code })
      .expect(401);
    await verify(a.token, code).expect(200);
  });

  it('records each step as a security event, without the code', async () => {
    const a = await admin();
    const since = new Date();
    await ask(a.token).expect(202);
    const code = await waitForOtp(a.email, since);
    await verify(a.token, code === '000000' ? '111111' : '000000').expect(403);
    await verify(a.token, code).expect(200);
    const read = auditReaders(h);
    for (const event of [
      'platform.step_up_requested',
      'platform.step_up_failed',
      'platform.step_up_verified',
    ] as const) {
      const rows = await read.security({ event, platformAdminId: a.id });
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toEqual({ sessionId: a.sessionId });
      expect(JSON.stringify(rows[0])).not.toContain(code);
    }
  });
});
