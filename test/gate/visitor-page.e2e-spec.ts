import type Redis from 'ioredis';
import { Client } from 'pg';
import type { Response } from 'supertest';
import { AccessTokens } from '../../src/core/auth/access-token';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { REDIS } from '../../src/core/redis/redis.token';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { VISITOR_DATA_SWEEP } from '../../src/gate/visitors/visitor-data.sweep';
import { auditReaders } from '../setup/audit';
import {
  createHttpHarness,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { required } from '../setup/test-env';
import { keyPaths } from '../api/keys';
import { call } from '../api/request';
import { passBody } from '../api/routes/visitors';
import { workerBody } from '../api/routes/workers';
import { buildWorld, type World } from '../api/world';

const PAGE = [
  'code',
  'compoundName',
  'emergencyPhone',
  'kind',
  'partySize',
  'qrPayload',
  'schedule',
  'status',
  'statusReason',
  'timeZone',
  'unitCode',
  'validFrom',
  'validUntil',
  'visitorDirections',
];
const LINK = /^https:\/\/app\.jiwar\.test\/v#([A-Za-z0-9_-]{43})$/;
const DAY = 86_400_000;

/**
 * The visitor's public page (ADR 0030): the link is the verification. The
 * documented fields only, every status, one 404 for every link that is not
 * live, the three headers on every answer, rate limits, and "this isn't me".
 */
describe('Gate — the visitor page (ADR 0030)', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  const lookup = (token: unknown) =>
    call(w, 'POST', '/public/visitor-passes/lookup', { body: { token } });
  const notMe = (token: unknown) =>
    call(w, 'POST', '/public/visitor-passes/not-me', { body: { token } });

  async function pass(
    over: object = {},
    hostToken = w.a.tokens.owner,
    unitId = w.a.homeUnitId,
  ) {
    const res = await call(w, 'POST', `/units/${unitId}/visitor-passes`, {
      token: hostToken,
      body: passBody(over),
    }).expect(201);
    const b = res.body as { id: string; code: string; link: string };
    const m = LINK.exec(b.link);
    if (!m) throw new Error(`not a visitor link: ${b.link}`);
    return { id: b.id, code: b.code, token: m[1] };
  }

  const passRow = (id: string) =>
    w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.visitorPass.findUniqueOrThrow({ where: { id } }),
    );

  /** Status, every header a client sees, the body minus per-request ids. */
  function shape(res: Response): string {
    let body = '';
    if (res.text) {
      const parsed = JSON.parse(res.text) as Record<string, unknown>;
      delete parsed.requestId;
      delete parsed.timestamp;
      body = JSON.stringify(parsed);
    }
    return JSON.stringify({
      status: res.status,
      type: res.headers['content-type'],
      length: res.headers['content-length'],
      cache: res.headers['cache-control'] ?? null,
      referrer: res.headers['referrer-policy'] ?? null,
      robots: res.headers['x-robots-tag'] ?? null,
      body,
    });
  }

  const headersOf = (res: Response) => ({
    cache: res.headers['cache-control'],
    referrer: res.headers['referrer-policy'],
    robots: res.headers['x-robots-tag'],
  });
  const PAGE_HEADERS = {
    cache: 'no-store',
    referrer: 'no-referrer',
    robots: 'noindex',
  };

  it('shows the documented fields, and nothing about the host or anyone else', async () => {
    await call(w, 'PATCH', '/settings', {
      token: w.a.tokens.manager,
      body: {
        visitorDirections: 'Gate 2, then the second left.',
        emergencyPhone: '+201000000777',
      },
    }).expect(200);
    const visitorPhone = uniquePhone();
    const p = await pass(
      { visitorName: 'Page Guest', visitorPhone },
      w.a.tokens.family,
    );
    const res = await lookup(p.token).expect(200);
    expect(headersOf(res)).toEqual(PAGE_HEADERS);
    expect(keyPaths(res.body)).toEqual(PAGE);
    const [tenant, unit] = await Promise.all([
      h.moduleRef
        .get(GlobalDbService)
        .tenant.findUniqueOrThrow({ where: { id: w.a.tenantId } }),
      w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.unit.findUniqueOrThrow({
          where: { id: w.a.homeUnitId },
        }),
      ),
    ]);
    const row = await passRow(p.id);
    expect(res.body).toEqual({
      compoundName: tenant.name,
      unitCode: unit.code,
      kind: 'one_time',
      partySize: 2,
      validFrom: row.validFrom.toISOString(),
      validUntil: row.validUntil.toISOString(),
      timeZone: 'Africa/Cairo',
      schedule: null,
      status: 'active',
      statusReason: null,
      code: p.code,
      qrPayload: `JWR1.${p.token}`,
      visitorDirections: 'Gate 2, then the second left.',
      emergencyPhone: '+201000000777',
    });
    // The host (a family member), the primary, the guard, the visitor.
    const people = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.account.findMany({
        where: { id: { in: [w.a.ids.family, w.a.ids.owner, w.a.ids.guard] } },
        select: { id: true, fullName: true, phone: true, email: true },
      }),
    );
    const text = JSON.stringify(res.body);
    for (const person of people)
      for (const value of Object.values(person))
        if (value)
          expect([person.id, text.includes(value)]).toEqual([person.id, false]);
    expect(text).not.toContain('Page Guest');
    expect(text).not.toContain(visitorPhone);

    // A recurring pass shows its schedule.
    const recurring = await pass({
      kind: 'recurring',
      validUntil: new Date(Date.now() + 30 * DAY).toISOString(),
      schedule: { days: [4, 5], windows: [{ from: '22:00', to: '02:00' }] },
    });
    expect((await lookup(recurring.token).expect(200)).body).toMatchObject({
      kind: 'recurring',
      schedule: { days: [4, 5], windows: [{ from: '22:00', to: '02:00' }] },
      status: 'active',
    });
    await call(w, 'PATCH', '/settings', {
      token: w.a.tokens.manager,
      body: { visitorDirections: null, emergencyPhone: null },
    }).expect(200);
  });

  it('says what became of the pass; the code only while it is active', async () => {
    const dead = { code: null, qrPayload: null };
    // Used by its one entry.
    const used = await pass();
    await call(w, 'POST', '/gate/entries', {
      token: w.a.tokens.guard,
      body: {
        subjectType: 'visitor_pass',
        subjectId: used.id,
        direction: 'in',
      },
    }).expect(201);
    expect((await lookup(used.token).expect(200)).body).toMatchObject({
      status: 'used',
      statusReason: null,
      ...dead,
    });
    await call(w, 'POST', '/gate/entries', {
      token: w.a.tokens.guard,
      body: {
        subjectType: 'visitor_pass',
        subjectId: used.id,
        direction: 'out',
      },
    }).expect(201);
    // Expired.
    const expired = await pass({
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await h.moduleRef
      .get(SweepRunner)
      .run(VISITOR_DATA_SWEEP, new Date(Date.now() + 2 * 3_600_000));
    expect((await lookup(expired.token).expect(200)).body).toMatchObject({
      status: 'expired',
      statusReason: null,
      ...dead,
    });
    // Cancelled by the host.
    const cancelled = await pass();
    await call(w, 'POST', `/visitor-passes/${cancelled.id}/cancel`, {
      token: w.a.tokens.owner,
      body: { reasonCode: 'plans_changed' },
    }).expect(204);
    expect((await lookup(cancelled.token).expect(200)).body).toMatchObject({
      status: 'cancelled',
      statusReason: 'host_cancelled',
      ...dead,
    });
    // The host left (deactivated): to the visitor, also the host's doing.
    const unit = await w.helpers.unit(w.a);
    const host = await w.helpers.resident(w.a, [unit.id]);
    const left = await pass(
      {},
      await w.tokenFor(w.a, host.id, 'resident'),
      unit.id,
    );
    await call(w, 'PATCH', `/accounts/${host.id}/status`, {
      token: w.a.tokens.manager,
      body: { status: 'inactive' },
    }).expect(200);
    expect(await passRow(left.id)).toMatchObject({
      cancelReasonCode: 'host_inactive',
    });
    expect((await lookup(left.token).expect(200)).body).toMatchObject({
      status: 'cancelled',
      statusReason: 'host_cancelled',
      ...dead,
    });
    // Not the recipient.
    const wrong = await pass();
    await notMe(wrong.token).expect(204);
    expect((await lookup(wrong.token).expect(200)).body).toMatchObject({
      status: 'cancelled',
      statusReason: 'wrong_recipient',
      ...dead,
    });
  });

  it('one 404 for every link that is not live, on both routes', async () => {
    const tokens = h.moduleRef.get(AccessTokens);
    // Replaced by a reissue.
    const replaced = await pass();
    await call(w, 'POST', `/visitor-passes/${replaced.id}/reissue-link`, {
      token: w.a.tokens.owner,
    }).expect(200);
    // A worker's card token.
    const reg = await call(w, 'POST', `/units/${w.a.homeUnitId}/workers`, {
      token: w.a.tokens.owner,
      body: workerBody(),
    }).expect(201);
    const approved = await call(
      w,
      'POST',
      `/worker-engagements/${(reg.body as { engagementId: string }).engagementId}/review`,
      { token: w.a.tokens.manager, body: { decision: 'approve' } },
    ).expect(200);
    const workerToken = (
      approved.body as { card: { qrPayload: string } }
    ).card.qrPayload.slice('JWR1.'.length);
    // From before 4.1: no token, no pointer.
    const legacy = await pass();
    const db = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await db.connect();
    try {
      await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [
        w.a.tenantId,
      ]);
      await db.query(
        `UPDATE visitor_passes SET qr_token_hash = NULL WHERE id = $1`,
        [legacy.id],
      );
      await db.query(`DELETE FROM visitor_pass_links WHERE pass_id = $1`, [
        legacy.id,
      ]);
    } finally {
      await db.end();
    }
    // The legacy pass still works at the gate by its code.
    const atGate = await call(w, 'POST', '/gate/verify', {
      token: w.a.tokens.guard,
      body: { code: legacy.code },
    }).expect(200);
    expect(atGate.body).toMatchObject({ result: 'valid' });
    // Retained no longer: 30 days after its end.
    const retained = await pass({
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await h.moduleRef
      .get(SweepRunner)
      .run(VISITOR_DATA_SWEEP, new Date(Date.now() + 31 * DAY + 2 * 3_600_000));
    // A suspended compound's live pass.
    const inB = await pass({}, w.b.tokens.owner, w.b.homeUnitId);
    const globalDb = h.moduleRef.get(GlobalDbService);
    await globalDb.tenant.update({
      where: { id: w.b.tenantId },
      data: { status: 'suspended' },
    });
    try {
      const inputs: unknown[] = [
        tokens.newToken(),
        'abc',
        'a'.repeat(42) + '=',
        `JWR1.${tokens.newToken()}`,
        replaced.token,
        workerToken,
        legacy.token,
        retained.token,
        inB.token,
      ];
      for (const route of [lookup, notMe]) {
        const reference = await route(tokens.newToken());
        expect(reference.status).toBe(404);
        expect((reference.body as { code: string }).code).toBe(
          'VISITOR_PASS_NOT_FOUND',
        );
        expect(headersOf(reference)).toEqual(PAGE_HEADERS);
        for (const input of inputs) {
          const res = await route(input);
          expect([input, shape(res)]).toEqual([input, shape(reference)]);
        }
      }
    } finally {
      await globalDb.tenant.update({
        where: { id: w.b.tenantId },
        data: { status: 'active' },
      });
    }
    // Back in service, B's link answers again.
    await lookup(inB.token).expect(200);
  });

  it('is rate-limited per link and per IP, with the same headers', async () => {
    const p = await pass();
    const other = await pass();
    for (let i = 0; i < 20; i++) await lookup(p.token).expect(200);
    const limited = await lookup(p.token).expect(429);
    expect(headersOf(limited)).toEqual(PAGE_HEADERS);
    expect((limited.body as { code: string }).code).toBe('RATE_LIMITED');
    // The same link through the other route shares the budget.
    expect((await notMe(p.token)).status).toBe(429);
    await lookup(other.token).expect(200);

    // Per IP: the counter of the address the app sees, at its limit.
    const redis = h.moduleRef.get<Redis>(REDIS);
    const keys = ['127.0.0.1', '::ffff:127.0.0.1', '::1'].map(
      (ip) => `rl:visitor-page:ip:${ip}`,
    );
    for (const key of keys) await redis.set(key, '100000', 'EX', 60);
    try {
      const res = await lookup(other.token).expect(429);
      expect(headersOf(res)).toEqual(PAGE_HEADERS);
    } finally {
      await redis.del(...keys);
    }
    await lookup(other.token).expect(200);
  });

  it('"this isn\'t me" cancels, tells the host, audits as the system', async () => {
    const p = await pass({}, w.a.tokens.family);
    const res = await notMe(p.token).expect(204);
    expect(headersOf(res)).toEqual(PAGE_HEADERS);
    expect(await passRow(p.id)).toMatchObject({
      status: 'cancelled',
      cancelReasonCode: 'wrong_recipient',
      cancelledById: null,
      codeHash: null,
      qrTokenHash: null,
    });
    const notes = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.notification.findMany({
        where: { targetId: p.id },
      }),
    );
    const unit = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.unit.findUniqueOrThrow({
        where: { id: w.a.homeUnitId },
      }),
    );
    expect(
      notes.map((n) => ({
        accountId: n.accountId,
        kind: n.kind,
        priority: n.priority,
        params: n.params,
      })),
    ).toEqual([
      {
        accountId: w.a.ids.family,
        kind: 'visitor_pass.not_me',
        priority: 'normal',
        params: { unitCode: unit.code },
      },
    ]);
    const audit = await auditReaders(h).tenant(w.a.tenantId, {
      action: 'visitor_pass.cancelled',
      targetId: p.id,
    });
    expect(
      audit.map((a) => ({
        type: a.actorType,
        id: a.actorId,
        metadata: a.metadata,
      })),
    ).toEqual([
      { type: 'system', id: null, metadata: { reasonCode: 'wrong_recipient' } },
    ]);
    // The code is dead at the gate; a second call is the unknown 404.
    expect(
      (
        await call(w, 'POST', '/gate/verify', {
          token: w.a.tokens.guard,
          body: { code: p.code },
        }).expect(200)
      ).body,
    ).toMatchObject({ reason: 'unknown_code' });
    const again = await notMe(p.token);
    const unknown = await notMe(h.moduleRef.get(AccessTokens).newToken());
    expect(shape(again)).toBe(shape(unknown));
  });

  it('"this isn\'t me" races: one cancellation, or the entry first', async () => {
    const twice = await pass();
    const [x, y] = await Promise.all([notMe(twice.token), notMe(twice.token)]);
    expect([x.status, y.status].sort()).toEqual([204, 404]);
    const notes = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.notification.count({
        where: { targetId: twice.id },
      }),
    );
    expect(notes).toBe(1);
    expect(
      await auditReaders(h).tenant(w.a.tenantId, {
        action: 'visitor_pass.cancelled',
        targetId: twice.id,
      }),
    ).toHaveLength(1);

    // Against the entry: they serialize on the pass, one of them wins.
    const raced = await pass();
    const [cancel, entry] = await Promise.all([
      notMe(raced.token),
      call(w, 'POST', '/gate/entries', {
        token: w.a.tokens.guard,
        body: {
          subjectType: 'visitor_pass',
          subjectId: raced.id,
          direction: 'in',
        },
      }),
    ]);
    const row = await passRow(raced.id);
    if (cancel.status === 204) {
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(row.status).toBe('cancelled');
    } else {
      expect([cancel.status, entry.status]).toEqual([404, 201]);
      expect(row.status).toBe('used');
      await call(w, 'POST', '/gate/entries', {
        token: w.a.tokens.guard,
        body: {
          subjectType: 'visitor_pass',
          subjectId: raced.id,
          direction: 'out',
        },
      }).expect(201);
    }
  });
});
