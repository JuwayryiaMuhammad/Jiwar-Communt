import { financeHelpers } from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { permitHelpers, type PermitSetUp } from '../setup/permits';
import { decisionAppealHelpers } from '../setup/decision-appeals';

interface Err {
  code?: string;
  params?: Record<string, unknown>;
  fields?: { field: string; code: string }[];
}

/**
 * A works permit's finishing-works deposit (ADR 0074): the management
 * records it for the permit — a works permit of the deposit's unit, one
 * deposit each — and a compound that asks for it (the default) approves
 * works only once a deposit named on them holds money.
 */
describe('Fit-out — the works deposit', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;
  let f: ReturnType<typeof financeHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
    f = financeHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  const err = (res: { body: unknown }) => res.body as Err;
  const approve = (s: PermitSetUp, id: string) =>
    p.decide(s.manager, id, 'approve');

  it('a compound created after the migration starts with the rule on; residents read it', async () => {
    const s = await p.setUp('Deposit Default Court');
    expect(
      (
        (
          await p
            .http('get', '/staff/permit-settings', s.manager.token)
            .expect(200)
        ).body as { worksDepositRequired: boolean }
      ).worksDepositRequired,
    ).toBe(true);
    expect((await p.rules(s.alice)).worksDepositRequired).toBe(true);
    const row = await p.v.inTx(s.c, (tx) =>
      tx.permitSettings.findUniqueOrThrow({
        where: { tenantId: s.c.tenantId },
      }),
    );
    expect(row.worksDepositRequired).toBe(true);
  });

  it('waits for its deposit by default: refused, recorded for the permit, then approved', async () => {
    const s = await p.setUp('Deposit Wait Court');
    const permit = await p.works(s.alice, s.home.id);
    const refused = await approve(s, permit.id).expect(409);
    expect(err(refused)).toMatchObject({
      code: 'PERMIT_DEPOSIT_REQUIRED',
    });
    // No deposit recorded yet: no number to name.
    expect(err(refused)).not.toHaveProperty('params');
    expect((await p.row(s.c, permit.id)).status).toBe('pending');
    const deposit = await p.deposit(s.manager, permit.id);
    expect(deposit.held).toBe('5000.00');
    const listed = (
      await p
        .http('get', `/staff/units/${s.home.id}/deposits`, s.manager.token)
        .expect(200)
    ).body as { id: string; permitId: string | null }[];
    expect(listed.find((d) => d.id === deposit.id)?.permitId).toBe(permit.id);
    // The depositor sees which permit it is held for.
    const mine = (
      await p.http('get', '/me/deposits', s.alice.token).expect(200)
    ).body as { id: string; permitId: string | null }[];
    expect(mine.find((d) => d.id === deposit.id)?.permitId).toBe(permit.id);
    expect((await approve(s, permit.id).expect(200)).body).toMatchObject({
      status: 'approved',
    });
  });

  it('a compound that does not ask for it approves works at once; moves never wait', async () => {
    const s = await p.setUp('Deposit Off Court');
    const move = await p.move(s.alice, s.home.id);
    await approve(s, move.id).expect(200);
    const settings = await p.setRules(s.manager, {
      worksDepositRequired: false,
    });
    expect(settings.worksDepositRequired).toBe(false);
    const permit = await p.works(s.alice, s.home.id);
    await approve(s, permit.id).expect(200);
    const rows = await p.v.x.asManager(s.c, () =>
      p.v.x.prisma.tenant.auditLog.findMany({
        where: { action: 'permit_settings.changed' },
      }),
    );
    expect(rows.at(-1)).toMatchObject({
      changes: { worksDepositRequired: { from: true, to: false } },
    });
  });

  it('names a works permit of its own unit, once, and only on a finishing-works deposit', async () => {
    const s = await p.setUp('Deposit Permit Court');
    const other = await p.v.unit(s.c, 'P2');
    const bob = await p.v.owner(s.c, other.id);
    const permit = await p.works(s.alice, s.home.id);
    const theirs = await p.works(bob, other.id);
    const move = await p.move(s.alice, s.home.id);

    // Another kind of deposit names no permit.
    expect(
      err(
        await p.depositRaw(s.manager, permit.id, { kind: 'move' }).expect(400),
      ).fields,
    ).toEqual([{ field: 'permitId', code: 'FIELD_NOT_ALLOWED' }]);
    // A move permit, and the works of another unit, are not this deposit's.
    for (const wrong of [move.id, theirs.id]) {
      const res = await p
        .depositRaw(s.manager, permit.id, { permitId: wrong })
        .expect(400);
      expect(err(res).fields).toEqual([
        { field: 'permitId', code: 'INVALID_VALUE' },
      ]);
    }
    await p.deposit(s.manager, permit.id);
    expect(
      err(await p.depositRaw(s.manager, permit.id).expect(400)).fields,
    ).toEqual([{ field: 'permitId', code: 'DUPLICATE_VALUE' }]);
  });

  it('two deposits for one permit at once: one is recorded, the other refused', async () => {
    const s = await p.setUp('Deposit Race Court');
    const permit = await p.works(s.alice, s.home.id);
    const both = await Promise.all([
      p.depositRaw(s.manager, permit.id),
      p.depositRaw(s.manager, permit.id),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(
      await p.v.inTx(s.c, (tx) =>
        tx.financeDeposit.count({ where: { permitId: permit.id } }),
      ),
    ).toBe(1);
  });

  it('a deposit refunded whole holds nothing: the permit waits again', async () => {
    const s = await p.setUp('Deposit Refunded Court');
    const permit = await p.works(s.alice, s.home.id);
    const deposit = await p.deposit(s.manager, permit.id);
    await f.stepUp(s.manager.token);
    await p
      .http('post', `/staff/deposits/${deposit.id}/settle`, s.manager.token, {
        refund: { amount: '5000', channel: 'cash' },
      })
      .expect(200);
    expect(err(await approve(s, permit.id).expect(409))).toMatchObject({
      code: 'PERMIT_DEPOSIT_REQUIRED',
      params: { deposit: deposit.number },
    });
  });

  it('an overturned rejection with no deposit is left to the management: deposit_required', async () => {
    const d = decisionAppealHelpers(h);
    const s = await d.setUp('Deposit Appeal Court');
    const permit = await p.works(s.alice, s.home.id);
    await p
      .decide(s.manager, permit.id, 'reject', { reasonCode: 'outside_rules' })
      .expect(200);
    const lodged = await d.lodge(s.alice, 'permit_rejection', permit.id, {
      grounds: 'The works fit the rules.',
    });
    const decided = await d.decide(s.decider, lodged.id, {
      outcome: 'overturned',
    });
    expect(decided).toMatchObject({
      status: 'overturned',
      decision: { effect: 'follow_up', effectReason: 'deposit_required' },
    });
    expect((await p.row(s.c, permit.id)).status).toBe('rejected');
  });
});
