import { Client } from 'pg';
import type { Response } from 'supertest';
import { AccessTokens } from '../../src/core/auth/access-token';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { VISITOR_DATA_SWEEP } from '../../src/gate/visitors/visitor-data.sweep';
import { keyPaths } from '../api/keys';
import { call, err } from '../api/request';
import { passBody } from '../api/routes/visitors';
import { workerBody } from '../api/routes/workers';
import { buildWorld, type World } from '../api/world';
import { gateHelpers } from '../setup/gate';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { required } from '../setup/test-env';

/** Every day, all but one minute (an overnight window). */
const ALWAYS = {
  days: [0, 1, 2, 3, 4, 5, 6],
  windows: [{ from: '05:00', to: '04:59' }],
};
const QR = /^JWR1\.([A-Za-z0-9_-]{43})$/;

interface Issued {
  id: string;
  code: string;
  qr: string;
  token: string;
}

/**
 * QR entry (ADR 0030): one token per pass and engagement, the code derived
 * from it. A scanned QR is the code by other means — same answers, same
 * unknowns, same rate limit — and dies with it.
 */
describe('Gate — QR entry (ADR 0030)', () => {
  let h: HttpHarness;
  let w: World;
  let db: Client;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
    db = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await db.connect();
  }, 120_000);

  afterAll(async () => {
    await db.end();
    await h.close();
  });

  const tokens = () => h.moduleRef.get(AccessTokens);
  const tokenIn = (qr: string) => {
    const m = QR.exec(qr);
    if (!m) throw new Error(`not a Jiwar QR: ${qr}`);
    return m[1];
  };

  /** A guard of A with a fresh rate-limit budget, on duty at A's gate. */
  async function freshGuard(): Promise<string> {
    const g = await gateHelpers(h).guard(w.a);
    await gateHelpers(h).startShift(w.a, g.id, w.a.gateId);
    return w.tokenFor(w.a, g.id, 'staff');
  }
  let guardToken: string;
  beforeEach(async () => {
    guardToken = await freshGuard();
  });

  const verify = (body: object, token = guardToken) =>
    call(w, 'POST', '/gate/verify', { token, body });

  async function pass(
    side: 'a' | 'b' = 'a',
    over: object = {},
  ): Promise<Issued> {
    const s = w[side];
    const res = await call(w, 'POST', `/units/${s.homeUnitId}/visitor-passes`, {
      token: s.tokens.owner,
      body: passBody(over),
    }).expect(201);
    const b = res.body as { id: string; code: string; qrPayload: string };
    return {
      id: b.id,
      code: b.code,
      qr: b.qrPayload,
      token: tokenIn(b.qrPayload),
    };
  }

  async function worker(side: 'a' | 'b' = 'a'): Promise<Issued> {
    const s = w[side];
    const reg = await call(w, 'POST', `/units/${s.homeUnitId}/workers`, {
      token: s.tokens.owner,
      body: { ...workerBody(), schedule: ALWAYS },
    }).expect(201);
    const id = (reg.body as { engagementId: string }).engagementId;
    const approved = await call(w, 'POST', `/worker-engagements/${id}/review`, {
      token: s.tokens.manager,
      body: { decision: 'approve' },
    }).expect(200);
    const card = (
      approved.body as { card: { qrPayload: string; code: string } }
    ).card;
    return {
      id,
      code: card.code,
      qr: card.qrPayload,
      token: tokenIn(card.qrPayload),
    };
  }

  const engagementAction = (id: string, verb: string, body: object = {}) =>
    call(w, 'POST', `/worker-engagements/${id}/${verb}`, {
      token: w.a.tokens.owner,
      body,
    });

  /** Status, headers a client sees, and the body. */
  function shape(res: Response): string {
    return JSON.stringify({
      status: res.status,
      type: res.headers['content-type'],
      length: res.headers['content-length'],
      cache: res.headers['cache-control'] ?? null,
      body: res.text,
    });
  }

  /** Raw SQL in A, as the table owner (FORCE RLS binds it too). */
  async function inA(sql: string, params: unknown[]) {
    await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [
      w.a.tenantId,
    ]);
    return db.query(sql, params);
  }

  it('a QR and its code give the same answer, for a pass and for a worker', async () => {
    for (const issued of [await pass(), await worker()]) {
      const byCode = await verify({ code: issued.code }).expect(200);
      const byQr = await verify({ qr: issued.qr }).expect(200);
      expect(byQr.body).toEqual(byCode.body);
      expect(byQr.body).toMatchObject({
        result: 'valid',
        subjectId: issued.id,
      });
      // A scanner may add whitespace around the payload.
      expect(
        (await verify({ qr: ` ${issued.qr}\n` }).expect(200)).body,
      ).toEqual(byCode.body);
    }
  });

  it('unknown, malformed and foreign QRs answer exactly like an unknown code', async () => {
    const cancelled = await pass();
    await call(w, 'POST', `/visitor-passes/${cancelled.id}/cancel`, {
      token: w.a.tokens.owner,
      body: { reasonCode: 'other' },
    }).expect(204);
    const inputs: object[] = [
      { qr: `JWR1.${tokens().newToken()}` },
      { qr: 'JWR1.short' },
      { qr: 'JWR2.' + tokens().newToken() },
      { qr: tokens().newToken() },
      { qr: 'https://example.com/v#abc' },
      { qr: 'JWR1.' + 'a'.repeat(42) + '=' },
      { qr: (await pass('b')).qr },
      { qr: (await worker('b')).qr },
      { qr: cancelled.qr },
    ];
    const reference = await verify({ code: '000000' }).expect(200);
    expect(reference.body).toMatchObject({
      result: 'invalid',
      reason: 'unknown_code',
    });
    for (const body of inputs) {
      const res = await verify(body);
      expect([body, shape(res)]).toEqual([body, shape(reference)]);
    }
  });

  it('exactly one of code or qr', async () => {
    expect(err(await verify({}).expect(400)).fields).toEqual([
      { field: 'code', code: 'FIELD_REQUIRED' },
    ]);
    const issued = await pass();
    expect(
      err(await verify({ code: issued.code, qr: issued.qr }).expect(400))
        .fields,
    ).toEqual([{ field: 'qr', code: 'FIELD_NOT_ALLOWED' }]);
    expect(err(await verify({ qr: '' }).expect(400)).fields).toEqual([
      { field: 'qr', code: 'INVALID_LENGTH', params: { min: 1, max: 256 } },
    ]);
    expect(err(await verify({ qr: 5 }).expect(400)).fields).toEqual([
      { field: 'qr', code: 'INVALID_TYPE' },
    ]);
  });

  it('codes and QRs share one rate limit', async () => {
    const issued = await pass();
    for (let i = 0; i < 15; i++) {
      await verify({ code: '000000' }).expect(200);
      await verify({ qr: issued.qr }).expect(200);
    }
    for (const body of [{ qr: issued.qr }, { code: issued.code }]) {
      const res = await verify(body);
      expect([res.status, (res.body as { code: string }).code]).toEqual([
        429,
        'RATE_LIMITED',
      ]);
    }
  });

  it('entries record how they were identified', async () => {
    const issued = await pass();
    const byQr = await call(w, 'POST', '/gate/entries', {
      token: guardToken,
      body: {
        subjectType: 'visitor_pass',
        subjectId: issued.id,
        direction: 'in',
        via: 'qr',
      },
    }).expect(201);
    expect(byQr.body).toMatchObject({ method: 'qr', direction: 'in' });
    // An exit keeps its own method whatever `via` says.
    const out = await call(w, 'POST', '/gate/entries', {
      token: guardToken,
      body: {
        subjectType: 'visitor_pass',
        subjectId: issued.id,
        direction: 'out',
        via: 'qr',
      },
    }).expect(201);
    expect(out.body).toMatchObject({ method: 'guard' });
    const typed = await worker();
    const byCode = await call(w, 'POST', '/gate/entries', {
      token: guardToken,
      body: {
        subjectType: 'worker_engagement',
        subjectId: typed.id,
        direction: 'in',
      },
    }).expect(201);
    expect(byCode.body).toMatchObject({ method: 'code' });
    await call(w, 'POST', '/gate/entries', {
      token: guardToken,
      body: {
        subjectType: 'worker_engagement',
        subjectId: typed.id,
        direction: 'out',
      },
    }).expect(201);
    const bad = await call(w, 'POST', '/gate/entries', {
      token: guardToken,
      body: {
        subjectType: 'worker_engagement',
        subjectId: typed.id,
        direction: 'in',
        via: 'nfc',
      },
    }).expect(400);
    expect(err(bad).fields).toEqual([
      {
        field: 'via',
        code: 'INVALID_VALUE',
        params: { allowed: ['code', 'qr'] },
      },
    ]);
    const log = await call(w, 'GET', '/gate/entries', {
      token: w.a.tokens.manager,
      query: { subjectType: 'visitor_pass' },
    }).expect(200);
    const methods = (
      log.body as { data: { subjectId: string; method: string }[] }
    ).data
      .filter((e) => e.subjectId === issued.id)
      .map((e) => e.method);
    expect(methods.sort()).toEqual(['guard', 'qr']);
  });

  it('a worker: suspension stops the QR, resume restores it, a reissue kills it, the end clears it', async () => {
    const issued = await worker();
    await engagementAction(issued.id, 'suspend', {
      reasonCode: 'leave',
      reason: 'Away',
    }).expect(204);
    expect((await verify({ qr: issued.qr }).expect(200)).body).toMatchObject({
      result: 'invalid',
      reason: 'suspended',
    });
    await engagementAction(issued.id, 'resume').expect(200);
    expect((await verify({ qr: issued.qr }).expect(200)).body).toMatchObject({
      result: 'valid',
    });
    const reissued = await engagementAction(issued.id, 'reissue-code', {
      reasonCode: 'lost',
    }).expect(200);
    const card = (
      reissued.body as { card: { qrPayload: string; code: string } }
    ).card;
    for (const old of [{ qr: issued.qr }, { code: issued.code }]) {
      expect((await verify(old).expect(200)).body).toMatchObject({
        reason: 'unknown_code',
      });
    }
    for (const fresh of [{ qr: card.qrPayload }, { code: card.code }]) {
      expect((await verify(fresh).expect(200)).body).toMatchObject({
        result: 'valid',
      });
    }
    await engagementAction(issued.id, 'end', {
      reasonCode: 'work_finished',
      reason: 'Done',
    }).expect(204);
    expect(
      (await verify({ qr: card.qrPayload }).expect(200)).body,
    ).toMatchObject({
      reason: 'unknown_code',
    });
  });

  it('a pass: reissue, use and expiry kill its QR', async () => {
    const issued = await pass();
    const again = await call(
      w,
      'POST',
      `/visitor-passes/${issued.id}/reissue-link`,
      { token: w.a.tokens.owner },
    ).expect(200);
    const fresh = (again.body as { qrPayload: string }).qrPayload;
    expect((await verify({ qr: issued.qr }).expect(200)).body).toMatchObject({
      reason: 'unknown_code',
    });
    expect((await verify({ qr: fresh }).expect(200)).body).toMatchObject({
      result: 'valid',
    });
    // Used by its one entry.
    await call(w, 'POST', '/gate/entries', {
      token: guardToken,
      body: {
        subjectType: 'visitor_pass',
        subjectId: issued.id,
        direction: 'in',
        via: 'qr',
      },
    }).expect(201);
    expect((await verify({ qr: fresh }).expect(200)).body).toMatchObject({
      reason: 'unknown_code',
    });
    await call(w, 'POST', '/gate/entries', {
      token: guardToken,
      body: {
        subjectType: 'visitor_pass',
        subjectId: issued.id,
        direction: 'out',
      },
    }).expect(201);
    // Expired by the sweep.
    const short = await pass('a', {
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await h.moduleRef
      .get(SweepRunner)
      .run(VISITOR_DATA_SWEEP, new Date(Date.now() + 2 * 3_600_000));
    expect((await verify({ qr: short.qr }).expect(200)).body).toMatchObject({
      reason: 'unknown_code',
    });
  });

  it('rows from before 4.1 have no token: their code still works, no QR does', async () => {
    const legacyPass = await pass();
    const legacyWorker = await worker();
    await inA(`UPDATE visitor_passes SET qr_token_hash = NULL WHERE id = $1`, [
      legacyPass.id,
    ]);
    await inA(
      `UPDATE worker_engagements SET qr_token_hash = NULL WHERE id = $1`,
      [legacyWorker.id],
    );
    for (const legacy of [legacyPass, legacyWorker]) {
      expect(
        (await verify({ code: legacy.code }).expect(200)).body,
      ).toMatchObject({
        result: 'valid',
        subjectId: legacy.id,
      });
      expect((await verify({ qr: legacy.qr }).expect(200)).body).toMatchObject({
        reason: 'unknown_code',
      });
    }
  });

  it('a suspended engagement keeping a code never shadows the active one with it', async () => {
    const first = await worker();
    await engagementAction(first.id, 'suspend', {
      reasonCode: 'leave',
      reason: 'Away',
    }).expect(204);
    // Another engagement gets the very same token (so code and QR) while
    // the first is suspended: allowed, uniqueness covers active ones only.
    const spy = jest
      .spyOn(tokens(), 'newToken')
      .mockReturnValueOnce(first.token);
    let second: Issued;
    try {
      second = await worker();
    } finally {
      spy.mockRestore();
    }
    expect(second.code).toBe(first.code);
    // Created later, so the old "first row" lookup would have found either;
    // make the suspended one the newest to prove the active one wins.
    await inA(
      `UPDATE worker_engagements SET created_at = now() + interval '1 hour' WHERE id = $1`,
      [first.id],
    );
    for (const body of [{ code: first.code }, { qr: first.qr }]) {
      expect((await verify(body).expect(200)).body).toMatchObject({
        result: 'valid',
        subjectId: second.id,
      });
    }
  });

  it('no token or code is stored anywhere in plain form', async () => {
    const secrets: Issued[] = [];
    for (let i = 0; i < 3; i++) secrets.push(await pass());
    const relinked = await pass();
    const again = await call(
      w,
      'POST',
      `/visitor-passes/${relinked.id}/reissue-link`,
      { token: w.a.tokens.owner },
    ).expect(200);
    const b = again.body as { code: string; qrPayload: string };
    secrets.push(relinked, {
      id: relinked.id,
      code: b.code,
      qr: b.qrPayload,
      token: tokenIn(b.qrPayload),
    });
    const engaged = await worker();
    secrets.push(engaged);
    const reissued = await engagementAction(engaged.id, 'reissue-code', {
      reasonCode: 'lost',
    }).expect(200);
    const card = (
      reissued.body as { card: { qrPayload: string; code: string } }
    ).card;
    secrets.push({
      id: engaged.id,
      code: card.code,
      qr: card.qrPayload,
      token: tokenIn(card.qrPayload),
    });

    const columns = await db.query<{ table: string; column: string }>(`
      SELECT c.table_name AS table, c.column_name AS column
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
         AND c.table_name <> '_prisma_migrations'
         AND c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb')`);
    const withTenant = new Set(
      (
        await db.query<{ table: string }>(`
          SELECT table_name AS table FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'tenant_id'`)
      ).rows.map((r) => r.table),
    );
    await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [
      w.a.tenantId,
    ]);
    const tokenPatterns = secrets.map((s) => `%${s.token}%`);
    // A code is a run of exactly 6 or 8 digits, so a phone number or an id
    // that merely contains it does not count.
    const codePatterns = secrets.map((s) => `(^|[^0-9])${s.code}([^0-9]|$)`);
    const found: string[] = [];
    for (const { table, column } of columns.rows) {
      const scope = withTenant.has(table) ? `AND tenant_id = $3` : '';
      const params: unknown[] = [tokenPatterns, codePatterns];
      if (scope) params.push(w.a.tenantId);
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM "${table}"
          WHERE ("${column}"::text LIKE ANY($1::text[])
             OR "${column}"::text ~ ANY($2::text[])) ${scope}`,
        params,
      );
      if (Number(rows[0].n) > 0) found.push(`${table}.${column}`);
    }
    expect(found).toEqual([]);
    // The API never hands a token back after issuing it.
    const list = await call(
      w,
      'GET',
      `/units/${w.a.homeUnitId}/visitor-passes`,
      {
        token: w.a.tokens.owner,
      },
    ).expect(200);
    expect(keyPaths(list.body)).not.toContain('data[].qrPayload');
    for (const s of secrets)
      expect(JSON.stringify(list.body)).not.toContain(s.token);
  });
});
