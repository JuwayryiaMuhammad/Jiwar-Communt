import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { READINESS_COVERAGE } from '../setup/audit-coverage-split';
import type { Compound } from '../setup/community';
import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { readinessHelpers, type ReadinessSetUp } from '../setup/readiness';

/**
 * One scenario per entry of the readiness catalog (ADR 0014, 0067): actor,
 * target, changes and metadata — kinds, days, ids, amounts and codes; a
 * title only as changed, and nothing that names a person.
 */
const covered = new Set<string>();

describe('Audit coverage — readiness', () => {
  let h: HttpHarness;
  let r: ReturnType<typeof readinessHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: ReadinessSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    r = readinessHelpers(h);
    read = auditReaders(h);
    s = await r.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  async function single(c: Compound, action: string, targetId: string) {
    const rows = await read.tenant(c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    return rows[0];
  }

  it('readiness_program.created, .updated, .closed and .copied — the kind, the days, the counts; the title as changed only', async () => {
    const p = await r.program(s, {
      kind: 'season',
      title: 'AUDIT-secret Ramadan',
      startsOn: day(30),
      endsOn: day(59),
    });
    expect(await single(s.c, 'readiness_program.created', p.id)).toMatchObject({
      actorId: s.manager.id,
      changes: {
        kind: { from: null, to: 'season' },
        title: { changed: true },
        startsOn: { from: null, to: day(30) },
        endsOn: { from: null, to: day(59) },
      },
    });
    await r
      .http(
        'patch',
        `/maintenance/readiness/programs/${p.id}`,
        s.manager.token,
        {
          title: 'AUDIT-secret Summer',
          endsOn: day(60),
        },
      )
      .expect(200);
    expect(
      (await single(s.c, 'readiness_program.updated', p.id)).changes,
    ).toEqual({
      title: { changed: true },
      endsOn: { from: day(59), to: day(60) },
    });
    const kept = await r.item(s, p.id, { ownerId: s.supervisor.id });
    const copy = (
      await r
        .http(
          'post',
          `/maintenance/readiness/programs/${p.id}/copy`,
          s.manager.token,
          {
            startsOn: day(400),
          },
        )
        .expect(201)
    ).body as { id: string };
    expect(
      (await single(s.c, 'readiness_program.copied', copy.id)).metadata,
    ).toEqual({
      fromProgramId: p.id,
      startsOn: day(400),
      endsOn: day(430),
      items: 1,
      reassignedItemIds: [],
    });
    await r.done(s, kept.id).expect(200);
    await r
      .http(
        'post',
        `/maintenance/readiness/programs/${p.id}/close`,
        s.manager.token,
      )
      .expect(200);
    expect(
      (await single(s.c, 'readiness_program.closed', p.id)).metadata,
    ).toEqual({
      done: 1,
      open: 0,
      cancelled: 0,
    });
    const rows = await read.tenant(s.c.tenantId, { targetId: p.id });
    expect(JSON.stringify(rows)).not.toContain('AUDIT-secret');
  });

  it('readiness_item.created, .updated, .done and .cancelled — the program, the owner, the day, the amount, the decision and the reason', async () => {
    const p = await r.program(s);
    const contractId = await r.contract(s, day(40));
    const i = await r.item(s, p.id, {
      kind: 'contract_review',
      title: 'AUDIT-secret review',
      contractId,
      dueOn: day(10),
    });
    expect(await single(s.c, 'readiness_item.created', i.id)).toMatchObject({
      actorId: s.manager.id,
      metadata: { programId: p.id },
      changes: {
        kind: { from: null, to: 'contract_review' },
        title: { changed: true },
        ownerId: { from: null, to: s.supervisor.id },
        dueOn: { from: null, to: day(10) },
        contractId: { from: null, to: contractId },
      },
    });
    await r
      .http('patch', `/maintenance/readiness/items/${i.id}`, s.manager.token, {
        ownerId: s.techs[0].id,
        dueOn: day(12),
      })
      .expect(200);
    expect(await single(s.c, 'readiness_item.updated', i.id)).toMatchObject({
      metadata: { programId: p.id },
      changes: {
        ownerId: { from: s.supervisor.id, to: s.techs[0].id },
        dueOn: { from: day(10), to: day(12) },
      },
    });
    await r.done(s, i.id, { decision: 'renew' }).expect(200);
    expect((await single(s.c, 'readiness_item.done', i.id)).metadata).toEqual({
      programId: p.id,
      kind: 'contract_review',
      by: 'manage',
      decision: 'renew',
      contractId,
    });
    const e = await r.item(s, p.id, {
      kind: 'estimate',
      estimateAmount: '300',
    });
    await r
      .http(
        'post',
        `/maintenance/readiness/items/${e.id}/cancel`,
        s.manager.token,
        {
          reasonCode: 'out_of_budget',
        },
      )
      .expect(200);
    expect(
      (await single(s.c, 'readiness_item.cancelled', e.id)).metadata,
    ).toEqual({
      programId: p.id,
      kind: 'estimate',
      reasonCode: 'out_of_budget',
    });
    const rows = await read.tenant(s.c.tenantId, { targetId: i.id });
    expect(JSON.stringify(rows)).not.toContain('AUDIT-secret');
  });

  describe('catalog completeness', () => {
    it('every readiness entry has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of READINESS_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...READINESS_COVERAGE].sort());
    });
  });
});
