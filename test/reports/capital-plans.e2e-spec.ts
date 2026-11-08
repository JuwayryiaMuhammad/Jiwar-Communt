import { err } from '../api/request';
import { assetHelpers } from '../setup/assets';
import { budgetHelpers } from '../setup/budgets';
import { today } from '../setup/compound-clock';
import { superuserSql, type Who } from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface PlanBody {
  id: string;
  year: number;
  status: string;
  approvalRequestId: string | null;
  total: string;
  approvedAt: string | null;
  lines: {
    id: string;
    assetId: string | null;
    assetCode: string | null;
    amount: string;
    source: string;
  }[];
}

/**
 * ADR 0086: a year's capital plan to the board — one a year, seeded from
 * the register's replacements due, its lines kept while a draft, submitted
 * through the approvals (type `capital_plan`, its total the cost), locked
 * once approved, given back when rejected. Two writers meet: two plans of
 * a year, two raises of one plan.
 */
describe('Reports — the capital plan to the board', () => {
  let h: HttpHarness;
  let b: ReturnType<typeof budgetHelpers>;
  let a: ReturnType<typeof assetHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof budgetHelpers>['setUp']>>;
  let members: Who[];
  const year = () => Number(today().slice(0, 4));

  beforeAll(async () => {
    h = await createHttpHarness();
    b = budgetHelpers(h);
    a = assetHelpers(h);
    s = await b.setUp();
    members = s.owners.slice(0, 3);
  }, 120_000);

  afterAll(() => h.close());

  const http = (
    method: 'get' | 'post' | 'delete',
    path: string,
    body?: object,
  ) => b.http(method, path, s.manager.token, body);
  const create = (body: object) =>
    http('post', '/maintenance/capital-plans', body);
  const plan = async (id: string) =>
    (await http('get', `/maintenance/capital-plans/${id}`).expect(200))
      .body as PlanBody;
  const raise = (capitalPlanId: string, over: object = {}) =>
    http('post', '/staff/governance/approvals', {
      type: 'capital_plan',
      capitalPlanId,
      context: 'This year’s replacements',
      impact: 'What the compound renews',
      ...over,
    });
  const asset = (body: Record<string, unknown>) => a.asset(s as never, body);
  const withLine = async (y: number): Promise<PlanBody> => {
    const p = (await create({ year: y }).expect(201)).body as PlanBody;
    await http('post', `/maintenance/capital-plans/${p.id}/lines`, {
      description: 'Repaint the gate',
      amount: '5000.00',
    }).expect(201);
    return plan(p.id);
  };

  it('seeded from the register: the replacements due this year, an overdue one with them, none due later', async () => {
    const due = await asset({
      commissionedOn: `${year() - 10}-01-01`,
      expectedLifeYears: 10,
      replacementCost: '12000.00',
    });
    const overdue = await asset({
      commissionedOn: `${year() - 20}-01-01`,
      expectedLifeYears: 10,
      replacementCost: '3000.50',
    });
    const later = await asset({
      commissionedOn: `${year() - 9}-01-01`,
      expectedLifeYears: 10,
      replacementCost: '999.00',
    });
    const p = (await create({ year: year(), seed: true }).expect(201))
      .body as PlanBody;
    expect(p.status).toBe('draft');
    expect(p.lines.map((l) => l.assetId).sort()).toEqual([due, overdue].sort());
    expect(p.lines.map((l) => l.assetId)).not.toContain(later);
    expect(p.lines.every((l) => l.source === 'computed')).toBe(true);
    expect(p.total).toBe('15000.50');
    // One plan a year.
    const again = err(await create({ year: year() }).expect(409));
    expect(again).toMatchObject({ code: 'DUPLICATE_RESOURCE' });
    expect(again.fields).toEqual([{ field: 'year', code: 'DUPLICATE_VALUE' }]);
  });

  it('two plans of one year at once: one is drawn, the other refused', async () => {
    const [x, y] = await Promise.all([
      create({ year: year() + 1 }),
      create({ year: year() + 1 }),
    ]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
  });

  it('a draft’s lines: an asset once, the staff’s words, removed; a year out of range is refused', async () => {
    const p = await withLine(year() + 2);
    const pump = await asset({});
    await http('post', `/maintenance/capital-plans/${p.id}/lines`, {
      assetId: pump,
      description: 'A new pump',
      amount: '800',
    }).expect(201);
    expect(
      err(
        await http('post', `/maintenance/capital-plans/${p.id}/lines`, {
          assetId: pump,
          description: 'Twice',
          amount: '1',
        }).expect(409),
      ).fields,
    ).toEqual([{ field: 'assetId', code: 'DUPLICATE_VALUE' }]);
    const added = await plan(p.id);
    expect(added.total).toBe('5800.00');
    const gone = (
      await http(
        'delete',
        `/maintenance/capital-plans/${p.id}/lines/${added.lines[1].id}`,
      ).expect(200)
    ).body as PlanBody;
    expect(gone.total).toBe('5000.00');
    expect(
      err(await create({ year: year() + 9 }).expect(400)).fields?.[0],
    ).toMatchObject({ field: 'year', code: 'INVALID_NUMBER' });
  });

  it('to the board: submitted at the raise with its total, locked once approved', async () => {
    const p = await withLine(year() + 3);
    expect(err(await raise(p.id, { cost: '1.00' }).expect(400)).fields).toEqual(
      [{ field: 'cost', code: 'FIELD_NOT_ALLOWED' }],
    );
    const r = (await raise(p.id).expect(201)).body as {
      id: string;
      cost: string;
    };
    expect(r.cost).toBe('5000.00');
    expect(await plan(p.id)).toMatchObject({
      status: 'submitted',
      approvalRequestId: r.id,
    });
    expect(
      err(
        await http('post', `/maintenance/capital-plans/${p.id}/lines`, {
          description: 'Late',
          amount: '1',
        }).expect(409),
      ),
    ).toMatchObject({
      code: 'CAPITAL_PLAN_NOT_DRAFT',
      params: { status: 'submitted' },
    });
    await b.approve(members, r.id);
    const approved = await plan(p.id);
    expect(approved.status).toBe('approved');
    expect(approved.approvedAt).not.toBeNull();
    // Locked: the API refuses, and so does the database itself.
    expect(
      err(
        await http(
          'delete',
          `/maintenance/capital-plans/${p.id}/lines/${approved.lines[0].id}`,
        ).expect(409),
      ).code,
    ).toBe('CAPITAL_PLAN_NOT_DRAFT');
    await expect(
      superuserSql(`UPDATE capital_plans SET status = 'draft' WHERE id = $1`, [
        p.id,
      ]),
    ).rejects.toThrow(/locked/);
    await expect(
      superuserSql(`DELETE FROM capital_plan_lines WHERE plan_id = $1`, [p.id]),
    ).rejects.toThrow(/draft/);
    // Its one approval: a second raise finds it approved.
    expect(err(await raise(p.id).expect(409)).code).toBe(
      'CAPITAL_PLAN_NOT_DRAFT',
    );
  });

  it('two raises of one plan at once: one goes to the board, the other finds it submitted', async () => {
    const p = await withLine(year() + 4);
    const [x, y] = await Promise.all([raise(p.id), raise(p.id)]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    const lost = x.status === 409 ? x : y;
    expect(['CAPITAL_PLAN_NOT_DRAFT', 'DUPLICATE_RESOURCE']).toContain(
      err(lost).code,
    );
    const requests = await b.inTx(s.c, (tx) =>
      tx.governanceApprovalRequest.count({
        where: { type: 'capital_plan', subjectId: p.id },
      }),
    );
    expect(requests).toBe(1);
  });

  it('rejected, the draft comes back; an empty plan is not put to the board', async () => {
    const p = await withLine(year() + 5);
    const r = (await raise(p.id).expect(201)).body as { id: string };
    const m = await b.motion(members[0], r.id, { outcome: 'reject' });
    await b.vote(members[0], m.id, 'for').expect(201);
    await b.vote(members[1], m.id, 'for').expect(201);
    expect(await plan(p.id)).toMatchObject({
      status: 'draft',
      approvalRequestId: null,
    });
    const empty = (
      await http(
        'delete',
        `/maintenance/capital-plans/${p.id}/lines/${p.lines[0].id}`,
      ).expect(200)
    ).body as PlanBody;
    expect(empty.lines).toHaveLength(0);
    expect(err(await raise(p.id).expect(409)).code).toBe('CAPITAL_PLAN_EMPTY');
  });
});
