import { Client } from 'pg';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { required } from '../setup/test-env';
import { keyPaths, listKeys } from './keys';
import { call, err } from './request';
import { workerBody } from './routes/workers';
import { buildWorld, type World } from './world';

const PAYMENT = [
  'amount',
  'engagementId',
  'id',
  'paidAt',
  'paidBy',
  'paidBy.fullName',
  'paidBy.id',
  'period',
];

/** `YYYY-MM` of a date in the compound's zone (Africa/Cairo by default). */
const month = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
  })
    .format(d)
    .slice(0, 7);

/**
 * ADR 0037: a worker's monthly wage and its payments, recorded and never
 * processed. One payment per month; the worker gets a notice, the payer and
 * the primary a receipt. A payment settles nothing: the wage obligation of
 * an ended engagement (ADR 0022) stays open for management.
 */
describe('API v0 — worker wages', () => {
  let h: HttpHarness;
  let w: World;
  let globalDb: GlobalDbService;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
    globalDb = h.moduleRef.get(GlobalDbService);
  }, 120_000);

  afterAll(() => h.close());

  const owner = () => w.a.tokens.owner;
  const manager = () => w.a.tokens.manager;
  const thisMonth = () => month(new Date());

  /** An engagement of the owner's home, pending review. */
  async function registered(): Promise<string> {
    const res = await call(w, 'POST', `/units/${w.a.homeUnitId}/workers`, {
      token: owner(),
      body: workerBody(),
    }).expect(201);
    return (res.body as { engagementId: string }).engagementId;
  }

  /** An approved engagement: it has a code, so someone could work. */
  async function active(): Promise<string> {
    const id = await registered();
    await call(w, 'POST', `/worker-engagements/${id}/review`, {
      token: manager(),
      body: { decision: 'approve' },
    }).expect(200);
    return id;
  }

  const pay = (id: string, body: object, token = owner()) =>
    call(w, 'POST', `/worker-engagements/${id}/wage-payments`, {
      token,
      body,
    });

  const inA = <T>(fn: () => Promise<T>) => w.helpers.asManager(w.a, fn);

  it('the household sets the monthly wage; the list shows it; the trail never holds the amount', async () => {
    const id = await registered();
    const set = await call(w, 'PUT', `/worker-engagements/${id}/wage`, {
      token: owner(),
      body: { monthlyWage: 3200 },
    }).expect(200);
    expect(set.body).toEqual({ monthlyWage: '3200.00' });
    const list = await call(w, 'GET', `/units/${w.a.homeUnitId}/workers`, {
      token: owner(),
    }).expect(200);
    expect(
      (list.body as { data: { id: string; monthlyWage: string }[] }).data.find(
        (e) => e.id === id,
      )?.monthlyWage,
    ).toBe('3200.00');
    const [entry] = await auditReaders(h).tenant(w.a.tenantId, {
      action: 'worker.wage_changed',
      targetId: id,
    });
    expect(entry.metadata).toMatchObject({ set: true });
    expect(JSON.stringify(entry)).not.toContain('3200');

    const cleared = await call(w, 'PUT', `/worker-engagements/${id}/wage`, {
      token: owner(),
      body: { monthlyWage: null },
    }).expect(200);
    expect(cleared.body).toEqual({ monthlyWage: null });
    const missing = await call(w, 'PUT', `/worker-engagements/${id}/wage`, {
      token: owner(),
      body: {},
    }).expect(400);
    expect(err(missing).fields).toEqual([
      { field: 'monthlyWage', code: 'FIELD_REQUIRED' },
    ]);
  });

  it('a payment: the worker’s notice, the receipts, and its view', async () => {
    const id = await active();
    const res = await pay(id, {
      period: thisMonth(),
      amount: '3200.5',
    }).expect(201);
    expect(keyPaths(res.body)).toEqual(PAYMENT);
    expect(res.body).toMatchObject({
      engagementId: id,
      period: thisMonth(),
      amount: '3200.50',
      paidBy: { id: w.a.ids.owner },
    });
    const notice = await inA(() =>
      w.helpers.prisma.tenant.workerNotice.findMany({
        where: { engagementId: id, noticeKey: 'wage_paid' },
      }),
    );
    expect(notice.map((n) => n.params)).toEqual([
      { period: thisMonth(), amount: '3200.50' },
    ]);
    const mails = await globalDb.outboxMessage.findMany({
      where: { tenantId: w.a.tenantId, templateKey: 'community.wage_paid' },
    });
    // The owner paid and is the primary: one receipt.
    expect(mails.length).toBeGreaterThanOrEqual(1);

    const list = await call(
      w,
      'GET',
      `/worker-engagements/${id}/wage-payments`,
      { token: owner() },
    ).expect(200);
    expect(keyPaths(list.body)).toEqual(listKeys(PAYMENT));
    // Payroll reads them too.
    await call(w, 'GET', `/worker-engagements/${id}/wage-payments`, {
      token: manager(),
    }).expect(200);
  });

  it('one payment per month, even two at once', async () => {
    const id = await active();
    await pay(id, { period: thisMonth(), amount: 100 }).expect(201);
    const again = await pay(id, { period: thisMonth(), amount: 100 }).expect(
      409,
    );
    expect(err(again).code).toBe('WAGE_PERIOD_ALREADY_PAID');

    const other = await active();
    const results = await Promise.all([
      pay(other, { period: thisMonth(), amount: 100 }),
      pay(other, { period: thisMonth(), amount: 200 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(err(results.find((r) => r.status === 409)!).code).toBe(
      'WAGE_PERIOD_ALREADY_PAID',
    );
    const rows = await inA(() =>
      w.helpers.prisma.tenant.workerWagePayment.findMany({
        where: { engagementId: other },
      }),
    );
    expect(rows).toHaveLength(1);
    // The loser left nothing behind: one notice, for the amount that won.
    const winner = results.find((r) => r.status === 201)!.body as {
      id: string;
      amount: string;
    };
    expect(rows[0].id).toBe(winner.id);
    const notices = await inA(() =>
      w.helpers.prisma.tenant.workerNotice.findMany({
        where: { engagementId: other, noticeKey: 'wage_paid' },
      }),
    );
    expect(notices.map((n) => n.params)).toEqual([
      { period: thisMonth(), amount: winner.amount },
    ]);
  });

  it('the month and the amount are checked', async () => {
    const id = await active();
    const next = new Date();
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + 2);
    const future = await pay(id, { period: month(next), amount: 1 }).expect(
      400,
    );
    expect(err(future).fields).toEqual([
      { field: 'period', code: 'WAGE_PERIOD_IN_FUTURE' },
    ]);
    const before = await pay(id, { period: '2020-01', amount: 1 }).expect(400);
    expect(err(before).fields).toEqual([
      {
        field: 'period',
        code: 'WAGE_PERIOD_BEFORE_ENGAGEMENT',
        params: { first: thisMonth() },
      },
    ]);
    for (const amount of [0, -5, '1.234', 'ten', 1_000_000.01])
      expect(
        err(await pay(id, { period: thisMonth(), amount }).expect(400)).fields,
      ).toEqual([
        {
          field: 'amount',
          code: 'INVALID_NUMBER',
          params: { max: '1000000.00' },
        },
      ]);
  });

  it('nobody worked on a pending engagement: nothing to pay', async () => {
    const id = await registered();
    const res = await pay(id, { period: thisMonth(), amount: 1 }).expect(409);
    expect(err(res).code).toBe('WAGE_NOT_PAYABLE');
  });

  it('after the end: the wage is no longer set; a payment is recorded and settles nothing', async () => {
    const id = await active();
    await call(w, 'POST', `/worker-engagements/${id}/end`, {
      token: owner(),
      body: { reasonCode: 'work_finished', reason: 'Done' },
    }).expect(204);
    const obligation = () =>
      inA(() =>
        w.helpers.prisma.tenant.workerWageObligation.findFirstOrThrow({
          where: { engagementId: id, kind: 'settle_before_close' },
        }),
      );
    expect((await obligation()).settledAt).toBeNull();
    const wage = await call(w, 'PUT', `/worker-engagements/${id}/wage`, {
      token: owner(),
      body: { monthlyWage: 10 },
    }).expect(404);
    expect(err(wage).code).toBe('ENGAGEMENT_NOT_FOUND');

    await pay(id, { period: thisMonth(), amount: 900 }).expect(201);
    // The household's own record closes nothing (ADR 0022).
    expect(await obligation()).toMatchObject({
      settledAt: null,
      settledById: null,
    });
  });

  it('only those who may act on the engagement: a manager never pays, a member or a neighbour sees nothing', async () => {
    const id = await active();
    await pay(id, { period: thisMonth(), amount: 1 }, manager()).expect(403);
    await call(w, 'PUT', `/worker-engagements/${id}/wage`, {
      token: manager(),
      body: { monthlyWage: 1 },
    }).expect(403);
    // A household member is not the requester, the primary or a delegate:
    // they see the worker, never the wage or a payment.
    await call(w, 'PUT', `/worker-engagements/${id}/wage`, {
      token: owner(),
      body: { monthlyWage: 2750 },
    }).expect(200);
    const member = await pay(
      id,
      { period: thisMonth(), amount: 1 },
      w.a.tokens.family,
    );
    expect(member.status).toBe(403);
    const seen = await call(w, 'GET', `/units/${w.a.homeUnitId}/workers`, {
      token: w.a.tokens.family,
    }).expect(200);
    const item = (seen.body as { data: Record<string, unknown>[] }).data.find(
      (e) => e.id === id,
    )!;
    expect(item).toBeDefined();
    expect('monthlyWage' in item).toBe(false);
    expect(seen.text).not.toContain('2750');
    await call(w, 'GET', `/worker-engagements/${id}/wage-payments`, {
      token: w.a.tokens.family,
    }).expect(403);
    // A resident of another unit cannot see this one at all.
    const neighbour = await pay(
      id,
      { period: thisMonth(), amount: 1 },
      w.a.tokens.tenant,
    );
    expect(neighbour.status).toBe(404);
    const read = await call(
      w,
      'GET',
      `/worker-engagements/${id}/wage-payments`,
      { token: w.a.tokens.tenant },
    );
    expect(read.status).toBe(404);
    const rows = await inA(() =>
      w.helpers.prisma.tenant.workerWagePayment.count({
        where: { engagementId: id },
      }),
    );
    expect(rows).toBe(0);
  });

  it('payments are immutable in the database: the app may not, nobody can', async () => {
    const id = await active();
    await pay(id, { period: thisMonth(), amount: 5 }).expect(201);
    await expect(
      inA(() =>
        w.helpers.prisma.tenant.workerWagePayment.updateMany({
          where: { engagementId: id },
          data: { amount: 6 },
        }),
      ),
    ).rejects.toThrow(/permission denied/);
    // The owner of the table, in the compound (FORCE RLS applies to it
    // too), is stopped by the trigger.
    const db = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await db.connect();
    try {
      for (const sql of [
        'UPDATE worker_wage_payments SET amount = 6 WHERE engagement_id = $1',
        'DELETE FROM worker_wage_payments WHERE engagement_id = $1',
      ]) {
        await db.query('BEGIN');
        try {
          await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [
            w.a.tenantId,
          ]);
          await expect(db.query(sql, [id])).rejects.toThrow(
            /wage payments are immutable/,
          );
        } finally {
          await db.query('ROLLBACK');
        }
      }
    } finally {
      await db.end();
    }
  });
});
