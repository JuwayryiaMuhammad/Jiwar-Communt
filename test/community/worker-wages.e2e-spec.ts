import { DelegationsService } from '../../src/community/households/delegations.service';
import { WorkerWagesService } from '../../src/community/workers/worker-wages.service';
import { WorkersService } from '../../src/community/workers/workers.service';
import { communityHelpers, type Compound } from '../setup/community';
import { bornYearsAgo, nationalIdFor } from '../setup/fixtures';
import { gateHelpers } from '../setup/gate';
import {
  createHttpHarness,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { month } from '../setup/compound-clock';

/**
 * ADR 0037: who a wage belongs to. The employer side (the unit's primary, a
 * `workers` delegate, an engagement's requester for their own) reads and
 * writes it; the rest of the household sees the worker without it; staff
 * and managers never set a wage or record a payment.
 */
describe('Worker wages — the employer side', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let workers: WorkersService;
  let wages: WorkerWagesService;
  let c: Compound;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
    workers = h.moduleRef.get(WorkersService);
    wages = h.moduleRef.get(WorkerWagesService);
    c = await x.compound('Wages Court');
  });

  afterAll(() => h.close());

  const code = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { response?: { code?: string } }) => e.response?.code ?? 'unknown',
    );

  /** An approved engagement of the unit, registered by `as`. */
  async function engaged(
    unitId: string,
    as: <T>(fn: () => Promise<T>) => Promise<T>,
  ): Promise<string> {
    const reg = await as(() =>
      workers.register(unitId, {
        fullName: 'Wage Worker',
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(bornYearsAgo(30)),
        phone: uniquePhone(),
        capacity: 'live_in',
      }),
    );
    await x.asManager(c, () => workers.review(reg.engagementId, 'approve'));
    return reg.engagementId;
  }

  const payments = (engagementId: string) =>
    x.asManager(c, () =>
      x.prisma.tenant.workerWagePayment.count({ where: { engagementId } }),
    );

  it('the primary and a delegate read every wage, a requester their own, a member none', async () => {
    const unit = await x.unit(c);
    const owner = await x.resident(c, [unit.id]);
    const coTenant = await x.resident(c, [unit.id], 'tenant');
    const member = await x.joinFamily(c, unit.id, owner);
    const delegate = await x.joinFamily(c, unit.id, owner);
    const asOwner = <T>(fn: () => Promise<T>) =>
      x.as(c, { id: owner.id, type: 'resident' }, fn);
    const asCoTenant = <T>(fn: () => Promise<T>) =>
      x.as(c, { id: coTenant.id, type: 'resident' }, fn);
    const asMember = <T>(fn: () => Promise<T>) =>
      x.as(c, { id: member.id, type: 'family' }, fn);
    const asDelegate = <T>(fn: () => Promise<T>) =>
      x.as(c, { id: delegate.id, type: 'family' }, fn);
    await asOwner(() =>
      h.moduleRef.get(DelegationsService).create(
        unit.id,
        delegate.id,
        ['workers'],
        // eslint-disable-next-line no-restricted-syntax -- any future instant within a year: a delegation's expiry is an instant
        new Date(Date.now() + 30 * 86_400_000),
      ),
    );

    const ofOwner = await engaged(unit.id, asOwner);
    const ofCoTenant = await engaged(unit.id, asCoTenant);
    await asOwner(() => wages.setWage(ofOwner, '3100.00'));
    await asCoTenant(() => wages.setWage(ofCoTenant, '2900.00'));
    await asOwner(() => wages.pay(ofOwner, { period: month(), amount: 3100 }));

    /** engagement id → the wage the reader gets, or `hidden`. */
    const wagesSeenBy = async (as: typeof asOwner) => {
      const { items } = await as(() => workers.listForUnit(unit.id));
      return Object.fromEntries(
        items.map((e) => [e.id, 'monthlyWage' in e ? e.monthlyWage : 'hidden']),
      );
    };
    expect(await wagesSeenBy(asOwner)).toEqual({
      [ofOwner]: '3100.00',
      [ofCoTenant]: '2900.00',
    });
    expect(await wagesSeenBy(asDelegate)).toEqual({
      [ofOwner]: '3100.00',
      [ofCoTenant]: '2900.00',
    });
    // Their own engagement only, not the primary's.
    expect(await wagesSeenBy(asCoTenant)).toEqual({
      [ofOwner]: 'hidden',
      [ofCoTenant]: '2900.00',
    });
    expect(await wagesSeenBy(asMember)).toEqual({
      [ofOwner]: 'hidden',
      [ofCoTenant]: 'hidden',
    });

    // The worker's page: the wage and the last month paid, or neither.
    const page = (as: typeof asOwner, id: string) =>
      as(() => workers.engagementForUnit(unit.id, id));
    expect(await page(asOwner, ofOwner)).toMatchObject({
      monthlyWage: '3100.00',
      lastPaidPeriod: month(),
    });
    expect(await page(asDelegate, ofOwner)).toMatchObject({
      lastPaidPeriod: month(),
    });
    expect(await page(asCoTenant, ofCoTenant)).toMatchObject({
      monthlyWage: '2900.00',
      lastPaidPeriod: null,
    });
    for (const hidden of [
      await page(asCoTenant, ofOwner),
      await page(asMember, ofOwner),
    ]) {
      expect(hidden.id).toBe(ofOwner);
      expect('monthlyWage' in hidden).toBe(false);
      expect('lastPaidPeriod' in hidden).toBe(false);
    }

    // The payments follow the same line.
    expect(
      (await asDelegate(() => wages.payments(ofOwner))).items,
    ).toHaveLength(1);
    expect(await code(asCoTenant(() => wages.payments(ofOwner)))).toBe(
      'FORBIDDEN',
    );
    expect(await code(asMember(() => wages.payments(ofOwner)))).toBe(
      'FORBIDDEN',
    );
    // And so do the writes: a requester on their own, never on another's.
    expect(await code(asCoTenant(() => wages.setWage(ofOwner, '1.00')))).toBe(
      'FORBIDDEN',
    );
    expect(
      await code(
        asCoTenant(() => wages.pay(ofOwner, { period: month(), amount: 1 })),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await code(
        asMember(() => wages.pay(ofCoTenant, { period: month(), amount: 1 })),
      ),
    ).toBe('FORBIDDEN');
    await asCoTenant(() =>
      wages.pay(ofCoTenant, { period: month(), amount: 5 }),
    );
    await asDelegate(() => wages.setWage(ofCoTenant, '2950.00'));
    expect(await payments(ofOwner)).toBe(1);
    expect(await payments(ofCoTenant)).toBe(1);
  });

  it('a manager never records a payment or sets a wage, whatever the role holds; payroll reads', async () => {
    const unit = await x.unit(c);
    const owner = await x.resident(c, [unit.id]);
    const asOwner = <T>(fn: () => Promise<T>) =>
      x.as(c, { id: owner.id, type: 'resident' }, fn);
    const id = await engaged(unit.id, asOwner);
    await asOwner(() => wages.setWage(id, '2000.00'));

    // Straight at the service: no permission stands in the way here.
    expect(
      await code(
        x.asManager(c, () => wages.pay(id, { period: month(), amount: 10 })),
      ),
    ).toBe('FORBIDDEN');
    expect(await code(x.asManager(c, () => wages.setWage(id, '1.00')))).toBe(
      'FORBIDDEN',
    );
    expect(await code(x.asManager(c, () => wages.setWage(id, null)))).toBe(
      'FORBIDDEN',
    );
    expect(await payments(id)).toBe(0);
    const row = await x.asManager(c, () =>
      x.prisma.tenant.workerEngagement.findUniqueOrThrow({ where: { id } }),
    );
    expect(row.monthlyWage?.toFixed(2)).toBe('2000.00');

    await asOwner(() => wages.pay(id, { period: month(), amount: 2000 }));
    const read = await x.asManager(c, () => wages.payments(id));
    expect(read.items.map((p) => p.amount)).toEqual(['2000.00']);
  });

  it('only a manager settles a wage obligation', async () => {
    const unit = await x.unit(c);
    const owner = await x.resident(c, [unit.id]);
    const asOwner = <T>(fn: () => Promise<T>) =>
      x.as(c, { id: owner.id, type: 'resident' }, fn);
    const id = await engaged(unit.id, asOwner);
    await asOwner(() =>
      workers.end(id, { code: 'work_finished', text: 'Done' }),
    );
    const guard = await gateHelpers(h).guard(c);
    expect(
      await code(asOwner(() => wages.settleObligation(id, 'nothing_owed'))),
    ).toBe('FORBIDDEN');
    expect(
      await code(
        x.as(c, { id: guard.id, type: 'staff' }, () =>
          wages.settleObligation(id, 'nothing_owed'),
        ),
      ),
    ).toBe('FORBIDDEN');
    const open = () =>
      x.asManager(c, () =>
        x.prisma.tenant.workerWageObligation.count({
          where: { engagementId: id, settledAt: null },
        }),
      );
    expect(await open()).toBe(1);
    await x.asManager(c, () => wages.settleObligation(id, 'nothing_owed'));
    expect(await open()).toBe(0);
  });

  it('a staff account never records a payment or sets a wage', async () => {
    const unit = await x.unit(c);
    const owner = await x.resident(c, [unit.id]);
    const asOwner = <T>(fn: () => Promise<T>) =>
      x.as(c, { id: owner.id, type: 'resident' }, fn);
    const id = await engaged(unit.id, asOwner);
    const guard = await gateHelpers(h).guard(c);
    const asStaff = <T>(fn: () => Promise<T>) =>
      x.as(c, { id: guard.id, type: 'staff' }, fn);

    expect(
      await code(asStaff(() => wages.pay(id, { period: month(), amount: 10 }))),
    ).toBe('FORBIDDEN');
    expect(await code(asStaff(() => wages.setWage(id, '1.00')))).toBe(
      'FORBIDDEN',
    );
    expect(await payments(id)).toBe(0);
    const row = await x.asManager(c, () =>
      x.prisma.tenant.workerEngagement.findUniqueOrThrow({ where: { id } }),
    );
    expect(row.monthlyWage).toBeNull();
  });
});
