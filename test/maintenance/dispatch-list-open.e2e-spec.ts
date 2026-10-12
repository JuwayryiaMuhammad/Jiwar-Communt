import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { rewind } from '../setup/sla';
import { SlaSweep } from '../../src/maintenance/sla/sla-sweep';

type Helpers = ReturnType<typeof dispatchHelpers>;
type SetUp = Awaited<ReturnType<Helpers['setUp']>>;

interface Row {
  id: string;
  status: string;
  escalatedAt: string | null;
  sla: { overdue: boolean } | null;
}

const STATUSES = [
  'new',
  'assigned',
  'en_route',
  'in_progress',
  'on_hold',
  'completed',
  'closed',
  'cancelled',
] as const;
type Status = (typeof STATUSES)[number];

/** Every status but `closed` and `cancelled`. */
const UNFINISHED: readonly string[] = STATUSES.slice(0, 6);

/**
 * ADR 0034 (B2 update): the dispatch list's `open` filter is every status
 * but closed and cancelled, decided in SQL with the keyset on both of the
 * list's paths, whatever the SLA.
 */
describe('Maintenance — the dispatch list: the open filter', () => {
  let h: HttpHarness;
  let d: Helpers;
  let s: SetUp;
  const t = {} as Record<Status, string>;

  const step = (path: string, token: string, body?: object) =>
    d.http('post', path, token, body).expect(204);

  /** A ticket of the owner's, walked to `status` over HTTP. */
  async function ticketIn(c: SetUp, status: Status): Promise<string> {
    const tech = c.techs[0];
    const id = (
      (
        await d
          .http('post', '/tickets', c.owner.token, {
            unitId: c.unit.id,
            categoryId: await d.categoryId(c.c, 'general'),
            description: 'Open filter fixture',
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    if (status === 'new') return id;
    if (status === 'cancelled') {
      await step(`/maintenance/tickets/${id}/cancel`, c.supervisor.token, {
        reasonCode: 'invalid',
      });
      return id;
    }
    await step(`/maintenance/tickets/${id}/assign`, c.supervisor.token, {
      technicianId: tech.id,
    });
    if (status === 'assigned') return id;
    if (status === 'en_route') {
      await step(`/technician/tickets/${id}/en-route`, tech.token);
      return id;
    }
    await step(`/technician/tickets/${id}/start`, tech.token);
    if (status === 'in_progress') return id;
    if (status === 'on_hold') {
      await step(`/technician/tickets/${id}/hold`, tech.token, {
        holdReason: 'awaiting_parts',
      });
      return id;
    }
    await step(`/technician/tickets/${id}/complete`, tech.token);
    if (status === 'completed') return id;
    await step(`/tickets/${id}/confirm`, c.owner.token, { rating: 5 });
    return id;
  }

  /** The supervisor holds `tickets.dispatch` and nothing else. */
  const list = async (query = '', c: SetUp = s) =>
    (
      await d
        .http('get', `/maintenance/tickets?${query}`, c.supervisor.token)
        .expect(200)
    ).body as { data: Row[]; nextCursor: string | null };
  const ids = (rows: Row[]) => rows.map((r) => r.id);

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
    for (const status of STATUSES) t[status] = await ticketIn(s, status);
  }, 120_000);

  afterAll(() => h.close());

  it('the fixture holds one ticket in every status', async () => {
    const all = (await list('limit=100')).data;
    expect(all).toHaveLength(STATUSES.length);
    expect(Object.fromEntries(all.map((r) => [r.status, r.id]))).toEqual(t);
  });

  it('`open=true` is every status but closed and cancelled, in the list’s order; `false` is no filter', async () => {
    const all = (await list('limit=100')).data;
    const open = (await list('open=true&limit=100')).data;
    expect(ids(open)).toEqual(
      ids(all.filter((r) => UNFINISHED.includes(r.status))),
    );
    expect(open.map((r) => r.status).sort()).toEqual([...UNFINISHED].sort());
    expect(ids(open)).not.toContain(t.closed);
    expect(ids(open)).not.toContain(t.cancelled);
    expect(ids((await list('open=false&limit=100')).data)).toEqual(ids(all));
  });

  it('combines with the other filters: both must hold', async () => {
    expect(ids((await list('open=true&status=completed')).data)).toEqual([
      t.completed,
    ]);
    expect((await list('open=true&status=closed')).data).toEqual([]);
    expect((await list('open=true&status=cancelled')).data).toEqual([]);
    expect(ids((await list('open=true&unassigned=true')).data)).toEqual([
      t.new,
    ]);
    // Unassigned alone also finds the cancelled ticket nobody ever took.
    expect(
      [...ids((await list('unassigned=true&limit=100')).data)].sort(),
    ).toEqual([t.new, t.cancelled].sort());
    expect(
      [
        ...ids(
          (await list(`open=true&technicianId=${s.techs[0].id}&limit=100`))
            .data,
        ),
      ].sort(),
    ).toEqual(
      [t.assigned, t.en_route, t.in_progress, t.on_hold, t.completed].sort(),
    );
    expect((await list('open=true&priority=emergency')).data).toEqual([]);
    expect((await list(`open=true&unitId=${s.manager.id}`)).data).toEqual([]);
  });

  it('pages by keyset: full pages, a true cursor, no finished ticket and no row twice', async () => {
    const whole = ids((await list('open=true&limit=100')).data);
    for (const size of [1, 4]) {
      const walked: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: { data: Row[]; nextCursor: string | null } = await list(
          `open=true&limit=${size}${cursor ? `&cursor=${cursor}` : ''}`,
        );
        // Full while more remain: the filter ran before the limit.
        if (page.nextCursor) expect(page.data).toHaveLength(size);
        walked.push(...ids(page.data));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(walked).toEqual(whole);
      expect(pages).toBe(Math.ceil(whole.length / size));
    }
  });

  it('a value that is not true or false is refused', async () => {
    const res = await d
      .http('get', '/maintenance/tickets?open=1', s.supervisor.token)
      .expect(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: [
        {
          field: 'open',
          code: 'INVALID_VALUE',
          params: { allowed: ['true', 'false'] },
        },
      ],
    });
  });

  describe('with the SLA flags (the list’s other path)', () => {
    let c: SetUp;
    const f = {} as Record<'late' | 'lateCancelled' | 'onTime', string>;

    beforeAll(async () => {
      c = await d.setUp(1);
      await d
        .http('patch', '/maintenance/sla-settings', c.manager.token, {
          slaEnabled: true,
        })
        .expect(200);
      await d.x.asManager(c.c, () => h.moduleRef.get(SlaSweep).pass());
      const late = async () => {
        const id = await ticketIn(c, 'new');
        await rewind(id, 24 * 60 + 1);
        await d
          .http('post', `/tickets/${id}/escalate`, c.owner.token)
          .expect(204);
        return id;
      };
      f.late = await late();
      // Escalated, then cancelled: still escalated, no longer open.
      f.lateCancelled = await late();
      await step(
        `/maintenance/tickets/${f.lateCancelled}/cancel`,
        c.supervisor.token,
        { reasonCode: 'invalid' },
      );
      f.onTime = await ticketIn(c, 'new');
    }, 120_000);

    it('`escalated=true` keeps returning the finished one; with `open=true` it does not', async () => {
      const all = (await list('limit=100', c)).data;
      const escalated = (await list('escalated=true&limit=100', c)).data;
      expect(ids(escalated)).toEqual(ids(all.filter((r) => r.escalatedAt)));
      expect([...ids(escalated)].sort()).toEqual(
        [f.late, f.lateCancelled].sort(),
      );
      expect(
        ids((await list('escalated=true&open=true&limit=100', c)).data),
      ).toEqual([f.late]);
    });

    it('`overdue=true` was always among open tickets: `open=true` changes nothing there', async () => {
      const overdue = ids((await list('overdue=true&limit=100', c)).data);
      expect(overdue).toEqual([f.late]);
      expect(
        ids((await list('overdue=true&open=true&limit=100', c)).data),
      ).toEqual(overdue);
      expect(
        (await list('overdue=true&open=true&status=cancelled', c)).data,
      ).toEqual([]);
    });

    it('a flagged list pages by keyset under `open` too', async () => {
      const second = await ticketIn(c, 'new');
      await rewind(second, 24 * 60 + 1);
      await d
        .http('post', `/tickets/${second}/escalate`, c.owner.token)
        .expect(204);
      const first = await list('escalated=true&open=true&limit=1', c);
      expect(ids(first.data)).toEqual([second]);
      expect(first.nextCursor).toEqual(expect.any(String));
      const next = await list(
        `escalated=true&open=true&limit=1&cursor=${first.nextCursor}`,
        c,
      );
      expect(ids(next.data)).toEqual([f.late]);
      expect(next.nextCursor).toBeNull();
    });
  });
});
