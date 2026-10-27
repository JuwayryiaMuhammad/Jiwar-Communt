import { today } from '../setup/compound-clock';
import { financeHelpers, type FinanceSetUp } from '../setup/finance';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Body {
  id: string;
  code?: string;
  params?: { owed?: string };
  verifyCode?: string;
  held?: string;
  status?: string;
  refundRequested?: boolean;
}

/** Clearance certificates and deposits (ADR 0062). */
describe('Clearances and deposits', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof financeHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = financeHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  const body = (res: { body: unknown }) => res.body as Body;
  const occupancyOf = async (s: FinanceSetUp) =>
    (
      await f.x.asManager(s.c, () =>
        f.x.prisma.tenant.unitOccupancy.findFirstOrThrow({
          where: { unitId: s.home.id, accountId: s.owner.id, status: 'active' },
        }),
      )
    ).id;

  it('a clearance only at a zero balance; its PDF and its public check', async () => {
    const s = await f.setUp('Clearance Court');
    await f.issue(s.manager, s.home.id);
    const refused = await f.http(
      'post',
      `/units/${s.home.id}/clearances`,
      s.owner.token,
    );
    expect([
      refused.status,
      body(refused).code,
      body(refused).params?.owed,
    ]).toEqual([409, 'CLEARANCE_BALANCE_DUE', '1000.00']);
    await f
      .http('post', `/staff/units/${s.home.id}/payments`, s.accountant.token, {
        amount: '1000',
        method: 'cash',
        paidOn: today(),
      })
      .expect(201);
    const issued = await f
      .http('post', `/units/${s.home.id}/clearances`, s.owner.token)
      .expect(201);
    expect(issued.headers['cache-control']).toBe('no-store');
    const record = await f.x.asManager(s.c, () =>
      f.x.prisma.tenant.financeClearance.findUniqueOrThrow({
        where: { id: body(issued).id },
      }),
    );
    expect(record.template).toBe('certificate.v2');
    const pdf = await f
      .http('get', `/clearances/${body(issued).id}/certificate`, s.owner.token)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

    const check = await h
      .http()
      .post(`${API}/public/clearances/lookup`)
      .send({ code: body(issued).verifyCode })
      .expect(200);
    // The compound, the number, the unit's code and the dates: no person, no id.
    expect(Object.keys(check.body as object).sort()).toEqual([
      'asOf',
      'compoundName',
      'number',
      'status',
      'unitCode',
      'validUntil',
    ]);
    expect(check.body).toMatchObject({ status: 'valid' });
    expect(JSON.stringify(check.body)).not.toContain(s.owner.id);
    await h
      .http()
      .post(`${API}/public/clearances/lookup`)
      .send({ code: 'A'.repeat(22) })
      .expect(404);
  });

  it('a deposit: recorded, a refund asked, settled with a dues deduction that clears the unit', async () => {
    const s = await f.setUp('Deposit Court');
    const occupancyId = await occupancyOf(s);
    const deposit = await f
      .http('post', '/staff/deposits', s.manager.token, {
        occupancyId,
        kind: 'finishing_works',
        amount: '3000',
        receivedOn: today(),
        method: 'bank_transfer',
        reference: 'TRX-1',
      })
      .expect(201);
    const id = body(deposit).id;
    await f
      .http('post', `/deposits/${id}/refund-request`, s.owner.token)
      .expect(200);
    expect(
      body(
        await f.http('post', `/deposits/${id}/refund-request`, s.owner.token),
      ).code,
    ).toBe('DEPOSIT_REFUND_ASKED');

    await f.issue(s.manager, s.home.id, {
      lines: [
        { descriptionEn: 'Dues', descriptionAr: 'مستحقات', amount: '500' },
      ],
    });
    const settle = {
      refund: { amount: '2400', channel: 'bank_transfer' },
      deductions: [{ reasonCode: 'unpaid_dues', amount: '500' }],
    };
    expect(
      body(
        await f.http(
          'post',
          `/staff/deposits/${id}/settle`,
          s.manager.token,
          settle,
        ),
      ).code,
    ).toBe('STEP_UP_REQUIRED');
    await f.stepUp(s.manager.token);
    expect(
      body(
        await f.http('post', `/staff/deposits/${id}/settle`, s.manager.token, {
          refund: { amount: '3001', channel: 'cash' },
        }),
      ).code,
    ).toBe('DEPOSIT_EXCEEDS_HELD');
    await f.stepUp(s.manager.token);
    const settled = await f
      .http('post', `/staff/deposits/${id}/settle`, s.manager.token, settle)
      .expect(200);
    expect(body(settled)).toMatchObject({
      held: '100.00',
      refundRequested: false,
    });
    // The dues were paid from the deposit: the unit clears now.
    await f
      .http('post', `/units/${s.home.id}/clearances`, s.owner.token)
      .expect(201);
  });

  /** A deposit of 3000 held for the unit's owner; its id. */
  async function held(s: FinanceSetUp) {
    return body(
      await f
        .http('post', '/staff/deposits', s.manager.token, {
          occupancyId: await occupancyOf(s),
          kind: 'move',
          amount: '3000',
          receivedOn: today(),
          method: 'cash',
        })
        .expect(201),
    ).id;
  }

  const refundAll = { refund: { amount: '3000', channel: 'cash' } };

  it('race: one deposit settled twice at once — refunded once', async () => {
    for (let i = 0; i < 3; i++) {
      const s = await f.setUp(`Deposit Twice Race ${i}`);
      const id = await held(s);
      // Two sessions of the manager, each with its own step-up.
      const other = await f.who(s.c, s.manager.id, 'manager');
      await f.stepUp(s.manager.token);
      await f.stepUp(other.token);
      const both = await Promise.all([
        f.http(
          'post',
          `/staff/deposits/${id}/settle`,
          s.manager.token,
          refundAll,
        ),
        f.http('post', `/staff/deposits/${id}/settle`, other.token, refundAll),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(both.map((r) => body(r).code).filter(Boolean)).toEqual([
        'DEPOSIT_EXCEEDS_HELD',
      ]);
      const refunded = await f.x.asManager(s.c, () =>
        f.x.prisma.tenant.financeDepositEvent.count({
          where: { depositId: id, kind: 'refunded' },
        }),
      );
      expect(refunded).toBe(1);
    }
  });

  it('race: a refund ask against the settlement — nothing left asked on an empty deposit', async () => {
    for (let i = 0; i < 3; i++) {
      const s = await f.setUp(`Deposit Ask Race ${i}`);
      const id = await held(s);
      await f.stepUp(s.manager.token);
      const [asked, settled] = await Promise.all([
        f.http('post', `/deposits/${id}/refund-request`, s.owner.token),
        f.http(
          'post',
          `/staff/deposits/${id}/settle`,
          s.manager.token,
          refundAll,
        ),
      ]);
      expect(settled.status).toBe(200);
      expect([200, 409]).toContain(asked.status);
      if (asked.status === 409)
        expect(body(asked).code).toBe('DEPOSIT_NOTHING_HELD');
      const [after] = body(
        await f.http('get', '/me/deposits', s.owner.token).expect(200),
      ) as unknown as Body[];
      expect(after).toMatchObject({ held: '0.00', refundRequested: false });
    }
  });

  it('race: a clearance against a new invoice never certifies over money owed', async () => {
    for (let i = 0; i < 3; i++) {
      const s = await f.setUp(`Clearance Race ${i}`);
      const [cleared] = await Promise.all([
        f.http('post', `/units/${s.home.id}/clearances`, s.owner.token),
        f.issue(s.manager, s.home.id),
      ]);
      if (cleared.status !== 201) continue;
      const clearance = await f.x.asManager(s.c, () =>
        f.x.prisma.tenant.financeClearance.findUniqueOrThrow({
          where: { id: body(cleared).id },
        }),
      );
      const invoice = await f.x.asManager(s.c, () =>
        f.x.prisma.tenant.invoice.findFirstOrThrow({
          where: { unitId: s.home.id },
        }),
      );
      expect(invoice.createdAt.getTime()).toBeGreaterThanOrEqual(
        clearance.asOf.getTime(),
      );
    }
  });
});
