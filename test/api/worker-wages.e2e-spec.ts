import { Client } from 'pg';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { auditReaders } from '../setup/audit';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { required } from '../setup/test-env';
import { keyPaths, listKeys } from './keys';
import { call, err } from './request';
import { workerBody } from './routes/workers';
import { buildWorld, type World } from './world';
import { month } from '../setup/compound-clock';
import { leakText } from '../setup/leak-text';

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

/**
 * ADR 0037: a worker's monthly wage and its payments, recorded and never
 * processed. One payment per month; the worker gets a notice, the payer and
 * the primary a receipt. A payment settles nothing: the wage obligation of
 * an ended engagement (ADR 0022) stays open until a manager closes it with
 * a reason code.
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
  const thisMonth = () => month();

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
    expect(leakText(entry)).not.toContain('3200');

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
    const future = await pay(id, { period: month(2), amount: 1 }).expect(400);
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
      settleReasonCode: null,
    });
  });

  const settle = (id: string, body: object, token = manager()) =>
    call(w, 'POST', `/worker-engagements/${id}/wage-obligation/settle`, {
      token,
      body,
    });
  const detail = async (id: string) =>
    (
      await call(w, 'GET', `/worker-engagements/${id}`, {
        token: manager(),
      }).expect(200)
    ).body as { openWageObligations: string[] };
  const endedWork = async () => {
    const id = await active();
    await call(w, 'POST', `/worker-engagements/${id}/end`, {
      token: owner(),
      body: { reasonCode: 'work_finished', reason: 'Done' },
    }).expect(204);
    return id;
  };

  it('a manager settles the obligation with a reason code: who, when, why, and the trail', async () => {
    const id = await endedWork();
    expect((await detail(id)).openWageObligations).toEqual([
      'settle_before_close',
    ]);
    // The household cannot: the route is the management's.
    await settle(id, { reasonCode: 'worker_confirmed' }, owner()).expect(403);
    const missing = await settle(id, {}).expect(400);
    expect(err(missing).code).toBe('REASON_REQUIRED');

    const before = Date.now();
    await settle(id, { reasonCode: 'worker_confirmed' }).expect(204);
    const row = await inA(() =>
      w.helpers.prisma.tenant.workerWageObligation.findFirstOrThrow({
        where: { engagementId: id, kind: 'settle_before_close' },
      }),
    );
    expect(row).toMatchObject({
      settledById: w.a.ids.manager,
      settleReasonCode: 'worker_confirmed',
    });
    expect(row.settledAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect((await detail(id)).openWageObligations).toEqual([]);
    const entries = await auditReaders(h).tenant(w.a.tenantId, {
      action: 'worker.wage_obligation_settled',
      targetId: id,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorId: w.a.ids.manager,
      metadata: {
        obligationId: row.id,
        kind: 'settle_before_close',
        reasonCode: 'worker_confirmed',
      },
    });
    // Once.
    const again = await settle(id, { reasonCode: 'nothing_owed' }).expect(409);
    expect(err(again).code).toBe('WAGE_OBLIGATION_NOT_OPEN');
  });

  it('nothing to settle while the engagement is open; two managers at once settle it once', async () => {
    const open = await active();
    const none = await settle(open, { reasonCode: 'nothing_owed' }).expect(409);
    expect(err(none).code).toBe('WAGE_OBLIGATION_NOT_OPEN');

    const id = await endedWork();
    const results = await Promise.all([
      settle(id, { reasonCode: 'worker_confirmed' }),
      settle(id, { reasonCode: 'household_payment_confirmed' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
    expect(
      await auditReaders(h).tenant(w.a.tenantId, {
        action: 'worker.wage_obligation_settled',
        targetId: id,
      }),
    ).toHaveLength(1);
  });

  /** An approved engagement whose worker was then reported underage. */
  const underage = async () => {
    const id = await active();
    const read = await call(w, 'GET', `/worker-engagements/${id}`, {
      token: manager(),
    }).expect(200);
    const workerId = (read.body as { worker: { id: string } }).worker.id;
    await call(w, 'POST', `/workers/${workerId}/report-underage`, {
      token: manager(),
      body: { reasonCode: 'report_received', reason: 'A report' },
    }).expect(201);
    return id;
  };
  const obligations = (id: string) =>
    inA(() =>
      w.helpers.prisma.tenant.workerWageObligation.findMany({
        where: { engagementId: id },
        orderBy: { kind: 'asc' },
      }),
    );
  const PAY_IN_FULL = [
    'household_payment_confirmed',
    'worker_confirmed',
    'referred_to_authorities',
  ];

  it('a manager closes the underage pay_in_full obligation, by kind and with its own reasons', async () => {
    const id = await underage();
    expect((await detail(id)).openWageObligations).toEqual(['pay_in_full']);
    // The default kind is the wage to settle: none is open here.
    const other = await settle(id, { reasonCode: 'worker_confirmed' }).expect(
      409,
    );
    expect(err(other).code).toBe('WAGE_OBLIGATION_NOT_OPEN');
    await settle(
      id,
      { kind: 'pay_in_full', reasonCode: 'worker_confirmed' },
      owner(),
    ).expect(403);
    const missing = await settle(id, { kind: 'pay_in_full' }).expect(400);
    expect(err(missing).code).toBe('REASON_REQUIRED');
    // Owed in full: never closed as "nothing owed".
    const wrong = await settle(id, {
      kind: 'pay_in_full',
      reasonCode: 'nothing_owed',
    }).expect(400);
    expect(err(wrong).fields).toEqual([
      {
        field: 'reasonCode',
        code: 'INVALID_REASON_CODE',
        params: { allowed: PAY_IN_FULL },
      },
    ]);
    const unknown = await settle(id, {
      kind: 'payroll',
      reasonCode: 'worker_confirmed',
    }).expect(400);
    expect(err(unknown).fields).toEqual([
      {
        field: 'kind',
        code: 'INVALID_VALUE',
        params: { allowed: ['pay_in_full', 'settle_before_close'] },
      },
    ]);
    expect(await obligations(id)).toEqual([
      expect.objectContaining({ kind: 'pay_in_full', settledAt: null }),
    ]);

    const before = Date.now();
    await settle(id, {
      kind: 'pay_in_full',
      reasonCode: 'referred_to_authorities',
    }).expect(204);
    const [row] = await obligations(id);
    expect(row).toMatchObject({
      kind: 'pay_in_full',
      settledById: w.a.ids.manager,
      settleReasonCode: 'referred_to_authorities',
    });
    expect(row.settledAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect((await detail(id)).openWageObligations).toEqual([]);
    const entries = await auditReaders(h).tenant(w.a.tenantId, {
      action: 'worker.wage_obligation_settled',
      targetId: id,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorId: w.a.ids.manager,
      metadata: {
        obligationId: row.id,
        kind: 'pay_in_full',
        reasonCode: 'referred_to_authorities',
      },
    });
    const again = await settle(id, {
      kind: 'pay_in_full',
      reasonCode: 'worker_confirmed',
    }).expect(409);
    expect(err(again).code).toBe('WAGE_OBLIGATION_NOT_OPEN');
  });

  it('with both kinds open, each closes alone', async () => {
    const id = await underage();
    await call(w, 'POST', `/worker-engagements/${id}/end`, {
      token: owner(),
      body: { reasonCode: 'work_finished', reason: 'Done' },
    }).expect(204);
    expect((await detail(id)).openWageObligations.sort()).toEqual([
      'pay_in_full',
      'settle_before_close',
    ]);
    await settle(id, {
      kind: 'pay_in_full',
      reasonCode: 'household_payment_confirmed',
    }).expect(204);
    expect((await detail(id)).openWageObligations).toEqual([
      'settle_before_close',
    ]);
    // The wage to settle keeps its own list.
    const wrong = await settle(id, {
      kind: 'settle_before_close',
      reasonCode: 'referred_to_authorities',
    }).expect(400);
    expect(err(wrong).fields).toEqual([
      expect.objectContaining({ code: 'INVALID_REASON_CODE' }),
    ]);
    await settle(id, {
      kind: 'settle_before_close',
      reasonCode: 'nothing_owed',
    }).expect(204);
    expect(
      (await obligations(id)).map((o) => [o.kind, o.settleReasonCode]),
    ).toEqual([
      ['pay_in_full', 'household_payment_confirmed'],
      ['settle_before_close', 'nothing_owed'],
    ]);
  });

  it('two managers at once close a pay_in_full obligation once, and the row names the one who did', async () => {
    const second = await h.createAccount(w.a.tenantId, {
      type: 'manager',
      email: uniqueEmail('mgr2'),
      phone: uniquePhone(),
    });
    const secondToken = await h.tokenFor({
      sub: second.id,
      tid: w.a.tenantId,
      typ: 'manager',
    });
    const id = await underage();
    const by = [
      { accountId: w.a.ids.manager, reasonCode: 'worker_confirmed' },
      { accountId: second.id, reasonCode: 'referred_to_authorities' },
    ];
    const results = await Promise.all([
      settle(id, { kind: 'pay_in_full', reasonCode: by[0].reasonCode }),
      settle(
        id,
        { kind: 'pay_in_full', reasonCode: by[1].reasonCode },
        secondToken,
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(err(loser).code).toBe('WAGE_OBLIGATION_NOT_OPEN');
    const winner = by[results.findIndex((r) => r.status === 204)];
    const rows = await obligations(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'pay_in_full',
      settledById: winner.accountId,
      settleReasonCode: winner.reasonCode,
    });
    const entries = await auditReaders(h).tenant(w.a.tenantId, {
      action: 'worker.wage_obligation_settled',
      targetId: id,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorId: winner.accountId,
      metadata: { kind: 'pay_in_full', reasonCode: winner.reasonCode },
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
    expect(leakText(seen.body)).not.toContain('2750');
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
