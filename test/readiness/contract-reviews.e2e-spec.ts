import { err } from '../api/request';
import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  readinessHelpers,
  type ItemRead,
  type ReadinessSetUp,
} from '../setup/readiness';

interface Due {
  contractId: string;
  code: string;
  endsOn: string;
  itemId: string | null;
}

/**
 * ADR 0067: before a program ends, the maintenance contracts that end by
 * its last day are reviewed — each once per program unless that review is
 * called off — and a review is done with what was decided.
 */
describe('Readiness — contract reviews', () => {
  let h: HttpHarness;
  let r: ReturnType<typeof readinessHelpers>;
  let s: ReadinessSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    r = readinessHelpers(h);
    s = await r.setUp(0);
  }, 90_000);

  afterAll(() => h.close());

  const due = async (programId: string): Promise<Due[]> =>
    (
      (
        await r
          .http(
            'get',
            `/maintenance/readiness/programs/${programId}/contracts-due`,
            s.manager.token,
          )
          .expect(200)
      ).body as { data: Due[] }
    ).data;

  it('lists the contracts in force that end by the program’s last day, soonest first, with their review', async () => {
    const p = await r.program(s, { startsOn: day(30), endsOn: day(59) });
    const soon = await r.contract(s, day(10));
    const inside = await r.contract(s, day(59));
    const after = await r.contract(s, day(60));
    const ended = await r.contract(s, day(-1));
    const cut = await r.contract(s, day(20));
    await r
      .http(
        'post',
        `/maintenance/contracts/${cut}/terminate`,
        s.manager.token,
        {
          reasonCode: 'replaced',
        },
      )
      .expect(200);
    const listed = await due(p.id);
    const ids = listed.map((d) => d.contractId);
    expect(ids.indexOf(soon)).toBeLessThan(ids.indexOf(inside));
    for (const gone of [after, ended, cut]) expect(ids).not.toContain(gone);
    expect(listed.find((d) => d.contractId === soon)).toMatchObject({
      endsOn: day(10),
      itemId: null,
    });
    const review = await r.item(s, p.id, {
      kind: 'contract_review',
      contractId: soon,
      dueOn: day(5),
    });
    expect((await due(p.id)).find((d) => d.contractId === soon)!.itemId).toBe(
      review.id,
    );
    // A contract not due for this program is not reviewed by it.
    for (const contractId of [after, ended, cut])
      expect(
        err(
          await r
            .newItem(s, p.id, { kind: 'contract_review', contractId })
            .expect(400),
        ).fields,
      ).toEqual([{ field: 'contractId', code: 'CONTRACT_NOT_DUE_FOR_REVIEW' }]);
  });

  it('reviews a contract once per program, again once that review is called off; done with its decision', async () => {
    const p = await r.program(s);
    const contractId = await r.contract(s, day(40));
    const review = () =>
      r.newItem(s, p.id, { kind: 'contract_review', contractId });
    const first = (await review().expect(201)).body as ItemRead;
    expect(err(await review().expect(409))).toMatchObject({
      code: 'DUPLICATE_RESOURCE',
    });
    await r
      .http(
        'post',
        `/maintenance/readiness/items/${first.id}/cancel`,
        s.manager.token,
        {
          reasonCode: 'covered_elsewhere',
        },
      )
      .expect(200);
    const second = (await review().expect(201)).body as ItemRead;
    expect(err(await r.done(s, second.id).expect(400)).fields).toEqual([
      { field: 'decision', code: 'FIELD_REQUIRED' },
    ]);
    expect(
      (await r.done(s, second.id, { decision: 'replace' }).expect(200)).body,
    ).toMatchObject({ state: 'done', decision: 'replace', contractId });
    // The same contract in another program is that program's to review.
    const other = await r.program(s);
    await r
      .newItem(s, other.id, { kind: 'contract_review', contractId })
      .expect(201);
  });
});
