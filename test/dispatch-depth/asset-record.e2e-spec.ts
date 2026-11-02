import { newId } from '../../src/core/common/uuid';
import { addDays } from '../../src/maintenance/schedules/local-dates';
import { assetHelpers, type AssetSetUp } from '../setup/assets';
import { today } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/** An answer's body, as the assertions read it. */
type Body = {
  code: string;
  fields: { field: string; code: string }[];
  [key: string]: unknown;
};

interface Entry {
  id: string;
  kind: string;
  code: string | null;
  ticketNumber: string | null;
  amount: string | null;
}

interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

/**
 * ADR 0076: an asset's whole history in one list (its events, its tickets
 * opened, completed with what was done and closed, its parts and costs,
 * its warranty claims), newest first, paged by a true keyset, codes and
 * amounts only; and the planned work due across every plan over up to 93
 * days, generated dates and the ones still to come.
 */
describe('Dispatch depth — an asset’s record and the planned work calendar', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof assetHelpers>;
  let s: AssetSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = assetHelpers(h);
    s = await a.setUp(1);
  }, 180_000);

  afterAll(() => h.close());

  async function lived(): Promise<{ assetId: string; ticketId: string }> {
    const assetId = await a.asset(s);
    await a
      .http('patch', `/maintenance/assets/${assetId}`, s.manager.token, {
        warrantyEndsOn: addDays(today(), 90),
      })
      .expect(200);
    const ticketId = (
      (
        await a
          .http('post', '/maintenance/work-orders', s.supervisor.token, {
            assetId,
            categoryId: await a.categoryId(s.c, 'plumbing'),
            description: 'SECRET-WORDS the seal leaks',
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    await a
      .http(
        'post',
        `/maintenance/tickets/${ticketId}/assign`,
        s.supervisor.token,
        {
          technicianId: s.techs[0].id,
        },
      )
      .expect(204);
    await a
      .http('post', `/technician/tickets/${ticketId}/start`, s.techs[0].token)
      .expect(204);
    await a
      .http(
        'post',
        `/maintenance/tickets/${ticketId}/costs`,
        s.supervisor.token,
        {
          kind: 'labour',
          description: 'SECRET-WORDS two hours',
          quantity: '2',
          unitAmount: '150',
        },
      )
      .expect(201);
    await a
      .http(
        'post',
        `/technician/tickets/${ticketId}/complete`,
        s.techs[0].token,
        {
          actionCode: 'repaired',
        },
      )
      .expect(204);
    await a
      .http(
        'post',
        `/maintenance/tickets/${ticketId}/accept-work`,
        s.supervisor.token,
      )
      .expect(204);
    await a
      .http('post', '/maintenance/warranty-claims', s.manager.token, {
        assetId,
        ticketId,
        description: 'SECRET-WORDS seal under warranty',
      })
      .expect(201);
    return { assetId, ticketId };
  }

  const timeline = (assetId: string, query = '') =>
    a.http(
      'get',
      `/maintenance/assets/${assetId}/timeline${query}`,
      s.manager.token,
    );

  it('everything that happened to it, newest first, codes and amounts only', async () => {
    const { assetId } = await lived();
    const res = await timeline(assetId).expect(200);
    const body = res.body as Page<Entry>;
    const kinds = body.data.map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'asset_event',
        'ticket_opened',
        'cost',
        'ticket_completed',
        'ticket_closed',
        'warranty_claim_opened',
      ]),
    );
    expect(kinds.indexOf('warranty_claim_opened')).toBeLessThan(
      kinds.indexOf('ticket_opened'),
    );
    expect(body.data.find((e) => e.kind === 'ticket_completed')).toMatchObject({
      code: 'repaired',
    });
    expect(body.data.find((e) => e.kind === 'cost')).toMatchObject({
      code: 'labour',
      amount: '300.00',
    });
    expect(body.data.find((e) => e.kind === 'ticket_opened')).toMatchObject({
      code: 'staff',
      ticketNumber: expect.stringMatching(/^MT-\d{6}$/) as string,
    });
    expect(JSON.stringify(res.body)).not.toContain('SECRET-WORDS');
  });

  it('pages by a true keyset: every entry once', async () => {
    const { assetId } = await lived();
    const all = ((await timeline(assetId).expect(200)).body as Page<Entry>)
      .data;
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Page<Entry> = (
        await timeline(
          assetId,
          `?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        ).expect(200)
      ).body as Page<Entry>;
      seen.push(...page.data.map((e) => `${e.kind}:${e.id}`));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all.map((e) => `${e.kind}:${e.id}`));
  });

  it('an unknown asset is not found', async () => {
    const res = await timeline(newId()).expect(404);
    expect((res.body as Body).code).toBe('ASSET_NOT_FOUND');
  });

  // --- the calendar ----------------------------------------------------------

  it('the dates a weekly plan will come due on, projected, across the window', async () => {
    const assetId = await a.asset(s);
    const plan = (
      await a
        .http('post', '/maintenance/plans', s.manager.token, {
          assetId,
          title: 'Weekly pump check',
          trigger: 'calendar',
          every: 1,
          unit: 'week',
          anchorOn: addDays(today(), 10),
        })
        .expect(201)
    ).body as { id: string };
    const from = today();
    const to = addDays(today(), 31);
    const res = await a
      .http(
        'get',
        `/maintenance/plan-calendar?from=${from}&to=${to}`,
        s.manager.token,
      )
      .expect(200);
    const mine = (
      res.body as { data: { planId: string; dueOn: string; status: string }[] }
    ).data.filter((e) => e.planId === plan.id);
    expect(mine.map((e) => [e.dueOn, e.status])).toEqual([
      [addDays(today(), 10), 'projected'],
      [addDays(today(), 17), 'projected'],
      [addDays(today(), 24), 'projected'],
      [addDays(today(), 31), 'projected'],
    ]);
  });

  it('refuses a window backwards or over 93 days', async () => {
    const res = await a
      .http(
        'get',
        `/maintenance/plan-calendar?from=${today()}&to=${addDays(today(), 94)}`,
        s.manager.token,
      )
      .expect(400);
    expect((res.body as Body).fields).toEqual([
      { field: 'to', code: 'INVALID_VALUE', params: { maxDays: 93 } },
    ]);
  });
});
