import { Client } from 'pg';
import { SlaSweep } from '../../src/maintenance/sla/sla-sweep';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { rewind } from '../setup/sla';

type Helpers = ReturnType<typeof dispatchHelpers>;
type SetUp = Awaited<ReturnType<Helpers['setUp']>>;

/** A normal ticket's default targets (ADR 0034), in minutes. */
const RESPONSE = 24 * 60;
const RESOLUTION = 7 * 24 * 60;

interface Row {
  id: string;
  status: string;
  sla: {
    responseDueAt: string | null;
    resolutionDueAt: string | null;
    paused: boolean;
    overdue: boolean;
    responseState: string | null;
    resolutionState: string | null;
  } | null;
  escalatedAt: string | null;
}

/**
 * ADR 0034: the dispatch list carries each ticket's SLA and this cycle's
 * escalation, read for the whole page at once, and filters by them. The
 * filters are decided in SQL and the rows in code: these tests hold the two
 * together, over every shape a ticket's clocks take.
 */
describe('Maintenance — the dispatch list: SLA, escalation and their filters', () => {
  let h: HttpHarness;
  let d: Helpers;
  let s: SetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  // --- helpers ---------------------------------------------------------------

  const enableSla = async (c: SetUp) => {
    await d
      .http('patch', '/maintenance/sla-settings', c.manager.token, {
        slaEnabled: true,
      })
      .expect(200);
    await d.x.asManager(c.c, () => h.moduleRef.get(SlaSweep).pass());
  };

  const open = async (c: SetUp = s) =>
    (
      (
        await d
          .http('post', '/tickets', c.owner.token, {
            unitId: c.unit.id,
            categoryId: await d.categoryId(c.c, 'general'),
            description: 'Dispatch list fixture',
          })
          .expect(201)
      ).body as { id: string }
    ).id;

  const assign = (id: string) =>
    d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: s.techs[0].id,
      })
      .expect(204);

  const work = (id: string, verb: string, body?: object) =>
    d
      .http('post', `/technician/tickets/${id}/${verb}`, s.techs[0].token, body)
      .expect(204);

  const escalate = (id: string) =>
    d.http('post', `/tickets/${id}/escalate`, s.owner.token).expect(204);

  /** The supervisor holds `tickets.dispatch` and nothing else. */
  const list = async (query = '', c: SetUp = s) =>
    (
      await d
        .http('get', `/maintenance/tickets?${query}`, c.supervisor.token)
        .expect(200)
    ).body as { data: Row[]; nextCursor: string | null };

  const ids = (rows: Row[]) => rows.map((r) => r.id);

  // --- the SLA off -----------------------------------------------------------

  it('while the compound measures no SLA: no row has one, and both filters are empty', async () => {
    const id = await open();
    const row = (await list('limit=100')).data.find((r) => r.id === id)!;
    expect(row).toMatchObject({ sla: null, escalatedAt: null });
    expect(await list('overdue=true')).toEqual({ data: [], nextCursor: null });
    expect(await list('escalated=true')).toEqual({
      data: [],
      nextCursor: null,
    });
    // `false` is no filter.
    expect(ids((await list('overdue=false&limit=100')).data)).toContain(id);
  });

  describe('with the SLA on', () => {
    const t = {} as Record<
      | 'fresh'
      | 'lateResponse'
      | 'responded'
      | 'lateResolution'
      | 'done'
      | 'escalated'
      | 'reopened'
      | 'paused',
      string
    >;

    beforeAll(async () => {
      await enableSla(s);

      t.fresh = await open();

      // Nobody answered in time.
      t.lateResponse = await open();
      await rewind(t.lateResponse, RESPONSE + 1);

      // Answered late: the response is breached, and met.
      t.responded = await open();
      await assign(t.responded);
      await rewind(t.responded, RESPONSE + 1);
      await work(t.responded, 'start');

      // Answered, and now the work itself is late.
      t.lateResolution = await open();
      await assign(t.lateResolution);
      await work(t.lateResolution, 'start');
      await rewind(t.lateResolution, RESOLUTION + 1);

      // Late, then reported done: nothing is owed any more.
      t.done = await open();
      await rewind(t.done, RESPONSE + 1);
      await assign(t.done);
      await work(t.done, 'start');
      await work(t.done, 'complete');

      // Late, and the resident said so.
      t.escalated = await open();
      await rewind(t.escalated, RESPONSE + 1);
      await escalate(t.escalated);

      // Escalated and breached in its first cycle, reopened into a second.
      t.reopened = await open();
      await rewind(t.reopened, RESPONSE + 1);
      await escalate(t.reopened);
      await assign(t.reopened);
      await work(t.reopened, 'start');
      await work(t.reopened, 'complete');
      await d
        .http('post', `/tickets/${t.reopened}/confirm`, s.owner.token, {
          rating: 3,
        })
        .expect(204);
      await d
        .http('post', `/tickets/${t.reopened}/reopen`, s.owner.token, {
          reasonCode: 'problem_returned',
          reason: 'Again',
        })
        .expect(204);

      // Waiting for parts: the clock is paused.
      t.paused = await open();
      await assign(t.paused);
      await work(t.paused, 'start');
      await work(t.paused, 'hold', { holdReason: 'awaiting_parts' });
    }, 120_000);

    const rowsById = async () =>
      new Map((await list('limit=100')).data.map((r) => [r.id, r]));

    it('each row says what the ticket page says: due times, paused, overdue, and when it was escalated', async () => {
      const rows = await rowsById();
      expect(rows.get(t.fresh)).toMatchObject({
        sla: {
          responseDueAt: expect.any(String) as string,
          resolutionDueAt: expect.any(String) as string,
          paused: false,
          overdue: false,
          responseState: 'running',
          resolutionState: 'running',
        },
        escalatedAt: null,
      });
      expect(rows.get(t.lateResponse)).toMatchObject({
        sla: { overdue: true, paused: false },
        escalatedAt: null,
      });
      expect(rows.get(t.responded)).toMatchObject({
        sla: { overdue: false, responseState: 'breached' },
      });
      expect(rows.get(t.lateResolution)).toMatchObject({
        sla: { overdue: true, responseState: 'met' },
      });
      expect(rows.get(t.done)).toMatchObject({ sla: { overdue: false } });
      expect(rows.get(t.escalated)).toMatchObject({
        sla: { overdue: true },
        escalatedAt: expect.any(String) as string,
      });
      // The first cycle's escalation and breach are not this cycle's.
      expect(rows.get(t.reopened)).toMatchObject({
        sla: { overdue: false },
        escalatedAt: null,
      });
      expect(rows.get(t.paused)).toMatchObject({
        sla: { paused: true, overdue: false, resolutionDueAt: null },
      });

      // The page of one ticket agrees with its row.
      for (const id of Object.values(t)) {
        const detail = (
          await d
            .http('get', `/maintenance/tickets/${id}`, s.supervisor.token)
            .expect(200)
        ).body as Row;
        expect({
          id,
          sla: detail.sla,
          escalatedAt: detail.escalatedAt,
        }).toEqual({
          id,
          sla: rows.get(id)!.sla,
          escalatedAt: rows.get(id)!.escalatedAt,
        });
      }
    });

    it('`overdue=true` is exactly the rows that say overdue, in the list’s order', async () => {
      const all = (await list('limit=100')).data;
      const filtered = (await list('overdue=true&limit=100')).data;
      expect(ids(filtered)).toEqual(ids(all.filter((r) => r.sla?.overdue)));
      expect(filtered.every((r) => r.sla?.overdue === true)).toBe(true);
      expect([...ids(filtered)].sort()).toEqual(
        [t.lateResponse, t.lateResolution, t.escalated].sort(),
      );
    });

    it('`escalated=true` is exactly the rows with an escalation of this cycle', async () => {
      const all = (await list('limit=100')).data;
      const filtered = (await list('escalated=true&limit=100')).data;
      expect(ids(filtered)).toEqual(ids(all.filter((r) => r.escalatedAt)));
      expect(ids(filtered)).toEqual([t.escalated]);
    });

    it('the filters combine with each other and with the others', async () => {
      expect(
        ids((await list('overdue=true&escalated=true&limit=100')).data),
      ).toEqual([t.escalated]);
      expect(
        [...ids((await list('overdue=true&unassigned=true')).data)].sort(),
      ).toEqual([t.lateResponse, t.escalated].sort());
      expect(ids((await list('overdue=true&status=in_progress')).data)).toEqual(
        [t.lateResolution],
      );
      expect(
        ids((await list(`overdue=true&technicianId=${s.techs[0].id}`)).data),
      ).toEqual([t.lateResolution]);
      expect((await list(`overdue=true&unitId=${s.manager.id}`)).data).toEqual(
        [],
      );
      expect((await list('overdue=true&priority=emergency')).data).toEqual([]);
      expect(
        ids(
          (
            await list(
              `overdue=true&categoryId=${await d.categoryId(s.c, 'general')}&limit=100`,
            )
          ).data,
        ),
      ).toHaveLength(3);
    });

    it('a filtered list pages by keyset: full pages, a true cursor, no row twice', async () => {
      const whole = ids((await list('overdue=true&limit=100')).data);
      const walked: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: { data: Row[]; nextCursor: string | null } = await list(
          `overdue=true&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
        );
        expect(page.data).toHaveLength(1);
        walked.push(...ids(page.data));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(walked).toEqual(whole);
      // The last page knows it is the last.
      expect(pages).toBe(whole.length);
    });

    it('a malformed cursor is refused under a filter too', async () => {
      const res = await d
        .http(
          'get',
          '/maintenance/tickets?overdue=true&cursor=nope',
          s.supervisor.token,
        )
        .expect(400);
      expect(res.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        fields: [{ field: 'cursor', code: 'INVALID_FORMAT' }],
      });
    });

    it('the SLA switched off again: the rows lose their SLA and the filters are empty', async () => {
      const c = await d.setUp(1);
      await enableSla(c);
      const id = await open(c);
      await rewind(id, RESPONSE + 1);
      expect(ids((await list('overdue=true', c)).data)).toEqual([id]);
      await d
        .http('patch', '/maintenance/sla-settings', c.manager.token, {
          slaEnabled: false,
        })
        .expect(200);
      expect((await list('', c)).data).toMatchObject([{ id, sla: null }]);
      expect((await list('overdue=true', c)).data).toEqual([]);
    });

    it('the list costs the same number of queries for one ticket as for many, filtered or not', async () => {
      const c = await d.setUp(1);
      await enableSla(c);
      const late = async () => {
        const id = await open(c);
        await rewind(id, RESPONSE + 1);
        await d
          .http('post', `/tickets/${id}/escalate`, c.owner.token)
          .expect(204);
      };
      const queries = async (query: string) => {
        const spy = jest.spyOn(Client.prototype, 'query');
        try {
          await list(query, c);
          return spy.mock.calls.length;
        } finally {
          spy.mockRestore();
        }
      };
      await late();
      await queries('limit=100'); // warm: the permission cache
      const single = {
        plain: await queries('limit=100'),
        flagged: await queries('overdue=true&escalated=true&limit=100'),
      };
      for (let i = 0; i < 6; i++) await late();
      expect(
        (await list('overdue=true&escalated=true&limit=100', c)).data,
      ).toHaveLength(7);
      expect({
        plain: await queries('limit=100'),
        flagged: await queries('overdue=true&escalated=true&limit=100'),
      }).toEqual(single);
      expect(single.plain).toBeGreaterThan(0);
    });
  });
});
