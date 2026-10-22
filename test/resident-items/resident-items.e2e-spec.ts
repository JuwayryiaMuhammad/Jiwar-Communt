import { Client } from 'pg';
import { boardAppealHelpers } from '../setup/board-appeals';
import { financeHelpers } from '../setup/finance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { managementHelpers } from '../setup/management';
import { neighboursHelpers, type Who } from '../setup/neighbours';

type SetUp = Awaited<ReturnType<ReturnType<typeof neighboursHelpers>['setUp']>>;

interface Item {
  type: string;
  id: string;
  number: string | null;
  status: string;
  lastActivityAt: string;
  unitId: string | null;
  kind: string | null;
  appeal: {
    state: string;
    at: string;
    decidedBy: string;
    decidedAt: string | null;
  } | null;
}

/**
 * The resident's lists across the domains (ADR 0058): everything they
 * asked for, every appeal, and a search over their own items — each source
 * by its own list's rule, never another unit's or another compound's.
 */
describe('The resident’s lists and search', () => {
  let h: HttpHarness;
  let n: ReturnType<typeof neighboursHelpers>;
  let m: ReturnType<typeof managementHelpers>;
  let fin: ReturnType<typeof financeHelpers>;
  let ba: ReturnType<typeof boardAppealHelpers>;
  let s: SetUp;
  let other: SetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    n = neighboursHelpers(h);
    m = managementHelpers(h);
    fin = financeHelpers(h);
    ba = boardAppealHelpers(h);
    s = await n.setUp();
    other = await n.setUp();
  }, 120_000);

  afterAll(() => h.close());

  const code = (r: { body: unknown }) => (r.body as { code: string }).code;
  const list = async (who: Who, path: string, query = '') =>
    (
      (await n.http('get', `${path}?limit=100${query}`, who.token).expect(200))
        .body as { data: Item[]; nextCursor: string | null }
    ).data;
  const search = async (who: Who, q: string) =>
    (
      (
        await n
          .http('get', `/me/search?q=${encodeURIComponent(q)}`, who.token)
          .expect(200)
      ).body as { data: Item[] }
    ).data;
  const categoryId = (c: SetUp['c'], key = 'general') =>
    n.inTx(
      c,
      async (tx) =>
        (await tx.ticketCategory.findFirstOrThrow({ where: { key } })).id,
    );
  const ticket = async (c: SetUp['c'], who: Who, unitId: string) =>
    (
      await n
        .http('post', '/tickets', who.token, {
          unitId,
          categoryId: await categoryId(c),
          description: 'Lists fixture',
        })
        .expect(201)
    ).body as { id: string; number: string };

  it('everything the resident asked for, newest first, each by its own rule', async () => {
    const t = await ticket(s.c, s.alice, s.homeA.id);
    const r = await m.open(s.c, s.alice, { unitId: s.homeA.id });
    const complaint = await n.complain(s.c, s.alice, s.homeB.code);
    const { invoiceId } = await fin.issue(s.manager, s.homeA.id);
    const dispute = (
      (
        await n
          .http('post', `/invoices/${invoiceId}/disputes`, s.alice.token, {
            reasonCode: 'wrong_amount',
          })
          .expect(201)
      ).body as { id: string }
    ).id;

    const mine = await list(s.alice, '/me/requests');
    const byType = Object.fromEntries(mine.map((i) => [i.type, i]));
    expect(byType.maintenance).toMatchObject({ id: t.id, status: 'new' });
    expect(byType.management).toMatchObject({ id: r.id, number: r.number });
    expect(byType.neighbour_complaint).toMatchObject({
      id: complaint.id,
      number: complaint.number,
      // The author's own unit, never the unit complained about.
      unitId: s.homeA.id,
    });
    expect(byType.invoice_dispute).toMatchObject({
      id: dispute,
      number: expect.stringMatching(/^INV-\d{6}$/) as string,
      status: 'open',
      unitId: s.homeA.id,
    });
    const times = mine.map((i) => new Date(i.lastActivityAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(mine.every((i) => i.appeal === null)).toBe(true);

    // Bob, in the unit complained about, sees none of it.
    const his = (await list(s.bob, '/me/requests')).map((i) => i.id);
    for (const id of [t.id, r.id, complaint.id, dispute])
      expect(his).not.toContain(id);
  });

  it('open and closed: the archive is what is finished', async () => {
    const r = await m.open(s.c, s.bob, { unitId: s.homeB.id });
    expect(
      (await list(s.bob, '/me/requests', '&state=open')).map((i) => i.id),
    ).toContain(r.id);
    await n
      .http('post', `/management-requests/${r.id}/withdraw`, s.bob.token)
      .expect(204);
    expect(
      (await list(s.bob, '/me/requests', '&state=open')).map((i) => i.id),
    ).not.toContain(r.id);
    expect(
      (await list(s.bob, '/me/requests', '&state=closed')).find(
        (i) => i.id === r.id,
      ),
    ).toMatchObject({ status: 'closed' });
  });

  it('the appeals: an appeal to the board, decided by the board', async () => {
    const disputeId = await ba.rejectedDispute(s.manager, s.alice, s.homeA.id);
    const lodged = await ba.appeal(s.alice, disputeId);
    const appeals = await list(s.alice, '/me/appeals');
    expect(appeals.find((i) => i.id === lodged.id)).toMatchObject({
      type: 'board_appeal',
      number: expect.stringMatching(/^BA-\d{4}$/) as string,
      status: 'pending',
      kind: 'invoice_dispute',
      unitId: s.homeA.id,
      appeal: { state: 'pending', decidedBy: 'board', decidedAt: null },
    });
    expect(
      (await list(s.alice, '/me/appeals', '&state=closed')).map((i) => i.id),
    ).not.toContain(lodged.id);
    expect((await list(s.bob, '/me/appeals')).map((i) => i.id)).not.toContain(
      lodged.id,
    );
  });

  it('the search finds the caller’s own items by reference or name, and nothing of another unit or compound', async () => {
    const mine = await ticket(s.c, s.alice, s.homeA.id);
    const theirs = await ticket(other.c, other.alice, other.homeA.id);
    // The other compound's first ticket has a number this compound's
    // tickets have too: each finds only its own.
    const ref = mine.number;
    const found = await search(s.alice, ref);
    expect(found.map((i) => i.id)).toContain(mine.id);
    const shared = (await search(s.alice, theirs.number)).map((i) => i.id);
    expect(shared).not.toContain(theirs.id);
    expect(shared.length).toBeGreaterThan(0);
    expect((await search(other.alice, theirs.number)).map((i) => i.id)).toEqual(
      [theirs.id],
    );
    expect(
      (await search(s.alice, ref.toLowerCase().replace('-', ''))).map(
        (i) => i.id,
      ),
    ).toContain(mine.id);
    // Another unit of the same compound: not theirs.
    expect((await search(s.bob, ref)).map((i) => i.id)).not.toContain(mine.id);
    // By the category's name, as the compound wrote it.
    const name = await n.inTx(
      s.c,
      async (tx) =>
        (
          await tx.ticketCategory.findFirstOrThrow({
            where: { key: 'general' },
          })
        ).nameEn,
    );
    expect(
      (await search(s.alice, name.slice(0, 4).toUpperCase())).map((i) => i.id),
    ).toContain(mine.id);
    // An invoice by its number, for whoever sees the unit's money.
    const { invoiceId } = await fin.issue(s.manager, s.homeA.id);
    const invoice = await n.inTx(s.c, (tx) =>
      tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } }),
    );
    const byNumber = await search(s.alice, `INV-${invoice.number}`);
    expect(byNumber.find((i) => i.id === invoiceId)).toMatchObject({
      type: 'invoice',
      status: expect.any(String) as string,
    });
    expect(
      (await search(s.bob, `INV-${invoice.number}`)).map((i) => i.id),
    ).not.toContain(invoiceId);
  });

  it('refuses wildcards and short or long text', async () => {
    for (const q of ['x', '%%', 'a_b', 'x'.repeat(65)]) {
      const res = await n
        .http('get', `/me/search?q=${encodeURIComponent(q)}`, s.alice.token)
        .expect(400);
      expect(code(res)).toBe('VALIDATION_FAILED');
    }
  });

  it('is limited to 30 searches a minute per account', async () => {
    const who = await n.owner(s.c, (await n.unit(s.c)).id);
    for (let i = 0; i < 30; i++) await search(who, `MT-${i + 1}`);
    const res = await n
      .http('get', '/me/search?q=MT-31', who.token)
      .expect(429);
    expect(code(res)).toBe('RATE_LIMITED');
    // Someone else is not limited by it.
    await search(s.bob, 'MT-1');
  });

  it('the staff have none of these lists', async () => {
    for (const path of ['/me/requests', '/me/appeals', '/me/search?q=MT-1']) {
      const res = await n.http('get', path, s.manager.token).expect(403);
      expect(code(res)).toBe('FORBIDDEN');
    }
  });

  it('costs the same number of queries for one item of a kind as for many', async () => {
    const who = await n.owner(s.c, (await n.unit(s.c)).id);
    const unitId = (
      await n.inTx(s.c, (tx) =>
        tx.unitOccupancy.findFirstOrThrow({ where: { accountId: who.id } }),
      )
    ).unitId;
    await ticket(s.c, who, unitId);
    await m.open(s.c, who, { unitId });
    const queries = async () => {
      const spy = jest.spyOn(Client.prototype, 'query');
      try {
        await n.http('get', '/me/requests?limit=100', who.token).expect(200);
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    };
    await queries(); // warm: the permission cache
    const single = await queries();
    for (let i = 0; i < 4; i++) {
      await ticket(s.c, who, unitId);
      await m.open(s.c, who, { unitId });
    }
    expect(await queries()).toBe(single);
  });
});
