import { StepUpService } from '../../src/core/auth/step-up.service';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { sessionOf } from '../api/world';
import { auditReaders } from '../setup/audit';
import { communityHelpers, type Compound } from '../setup/community';
import { codeOf } from '../setup/fixtures';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { waitForMessage, waitForOtp } from '../setup/mailpit';

/**
 * Step-up (ADR 0036): a fresh code to the account's own email, bound to the
 * session that asked, opening that session's next sensitive action once.
 */
describe('Step-up', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let c: Compound;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
    c = await x.compound('Step-up Court');
  });

  afterAll(() => h.close());

  async function someone() {
    const unit = await x.unit(c);
    const p = await x.resident(c, [unit.id]);
    const token = await h.tokenFor({
      sub: p.id,
      tid: c.tenantId,
      typ: 'resident',
    });
    return { ...p, token, sessionId: sessionOf(token) };
  }

  const ask = (token: string) =>
    h
      .http()
      .post(`${API}/me/step-up`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
  const verify = (token: string, code: string) =>
    h
      .http()
      .post(`${API}/me/step-up/verify`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code });

  /** Spends the session's step-up in a transaction, as an action would. */
  const consume = (p: { id: string; sessionId: string }) =>
    x.as(c, { id: p.id, type: 'resident', sessionId: p.sessionId }, () =>
      h.moduleRef
        .get(TenantTx)
        .withTenantTx((tx) => h.moduleRef.get(StepUpService).consume(tx)),
    );

  it('emails a code to the account, and a right code opens the session once', async () => {
    const p = await someone();
    const since = new Date();
    await ask(p.token).expect(202);
    const message = await waitForMessage(p.email, since);
    expect(message.Subject).toBe('رمز التأكيد من جوار');
    const code = await waitForOtp(p.email, since);

    expect(await codeOf(consume(p))).toBe('STEP_UP_REQUIRED');
    const wrong = code === '000000' ? '111111' : '000000';
    const refused = await verify(p.token, wrong).expect(403);
    expect((refused.body as { code: string }).code).toBe(
      'STEP_UP_CODE_INVALID',
    );

    const ok = await verify(p.token, code).expect(200);
    const until = new Date((ok.body as { expiresAt: string }).expiresAt);
    expect(Math.abs(until.getTime() - (Date.now() + 10 * 60_000))).toBeLessThan(
      60_000,
    );
    const session = await h.moduleRef
      .get(GlobalDbService)
      .session.findUniqueOrThrow({ where: { id: p.sessionId } });
    expect(session.stepUpUntil).toEqual(until);

    // One action, then it is spent.
    await consume(p);
    expect(await codeOf(consume(p))).toBe('STEP_UP_REQUIRED');
    // And the code itself is used up.
    await verify(p.token, code).expect(403);
  });

  it('is bound to the session that asked: another session cannot use the code', async () => {
    const p = await someone();
    const other = await h.tokenFor({
      sub: p.id,
      tid: c.tenantId,
      typ: 'resident',
    });
    const since = new Date();
    await ask(p.token).expect(202);
    const code = await waitForOtp(p.email, since);
    await verify(other, code).expect(403);
    expect(
      await codeOf(consume({ id: p.id, sessionId: sessionOf(other) })),
    ).toBe('STEP_UP_REQUIRED');
    // The asking session still can.
    await verify(p.token, code).expect(200);
  });

  it('a step-up that has expired opens nothing', async () => {
    const p = await someone();
    await h.moduleRef.get(GlobalDbService).session.update({
      where: { id: p.sessionId },
      data: { stepUpUntil: new Date(Date.now() - 1000) },
    });
    expect(await codeOf(consume(p))).toBe('STEP_UP_REQUIRED');
  });

  it('records each step as a security event, without the code', async () => {
    const p = await someone();
    const since = new Date();
    await ask(p.token).expect(202);
    const code = await waitForOtp(p.email, since);
    await verify(p.token, code === '000000' ? '111111' : '000000').expect(403);
    await verify(p.token, code).expect(200);
    const read = auditReaders(h);
    for (const event of [
      'step_up.requested',
      'step_up.failed',
      'step_up.verified',
    ]) {
      const rows = await read.security({ event, accountId: p.id });
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toEqual({ sessionId: p.sessionId });
      expect(JSON.stringify(rows[0])).not.toContain(code);
    }
  });
});
