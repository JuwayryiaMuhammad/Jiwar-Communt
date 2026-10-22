import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;

interface ResidentQuote {
  id: string;
  amount: string;
  note: string | null;
  status: string;
  decidedByMe: boolean | null;
  declineReason: string | null;
  mayDecide: boolean;
}

/**
 * A quote on a ticket (ADR 0058): the dispatch states the cost before the
 * work starts; the reporter or the unit's primary approves or declines it;
 * the work does not start while a quote waits or the last was declined.
 */
describe('Maintenance — quotes', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  const tech = () => s.techs[0];
  const code = (r: { body: unknown }) => (r.body as { code: string }).code;
  const params = (r: { body: unknown }) =>
    (r.body as { params: Record<string, unknown> }).params;

  const propose = (id: string, body: object = { amount: '350.5' }) =>
    d.http(
      'post',
      `/maintenance/tickets/${id}/quotes`,
      s.supervisor.token,
      body,
    );
  const quoteOf = async (id: string, body?: object) =>
    ((await propose(id, body).expect(201)).body as { id: string }).id;
  const residentQuotes = async (id: string, token = s.owner.token) =>
    (
      (await d.http('get', `/tickets/${id}/quotes`, token).expect(200))
        .body as { data: ResidentQuote[] }
    ).data;
  const approve = (id: string, quoteId: string, token = s.owner.token) =>
    d.http('post', `/tickets/${id}/quotes/${quoteId}/approve`, token);
  const decline = (
    id: string,
    quoteId: string,
    reasonCode = 'too_expensive',
    token = s.owner.token,
  ) =>
    d.http('post', `/tickets/${id}/quotes/${quoteId}/decline`, token, {
      reasonCode,
    });
  const start = (id: string) =>
    d.http('post', `/technician/tickets/${id}/start`, tech().token);

  async function assigned(): Promise<string> {
    const id = await d.openTicket(s);
    await d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: tech().id,
      })
      .expect(204);
    return id;
  }
  const notices = (kind: string, ticketId: string) =>
    d.inTenant(s.c, (tx) =>
      tx.notification.findMany({ where: { kind, targetId: ticketId } }),
    );

  it('proposed, told to the residents, approved: then the work starts', async () => {
    const id = await assigned();
    const quoteId = await quoteOf(id, {
      amount: '350.5',
      note: 'Replace the valve',
    });
    const [listed] = await residentQuotes(id);
    expect(listed).toMatchObject({
      id: quoteId,
      amount: '350.50',
      note: 'Replace the valve',
      status: 'proposed',
      decidedByMe: null,
      mayDecide: true,
    });
    const told = await notices('ticket.quote_proposed', id);
    expect(told.map((n) => n.accountId)).toEqual([s.owner.id]);
    expect(told[0].params).toMatchObject({ amount: '350.50' });

    // The work waits for the approval.
    const refused = await start(id).expect(409);
    expect(code(refused)).toBe('TICKET_QUOTE_NOT_APPROVED');
    expect(params(refused)).toEqual({ status: 'proposed' });

    await approve(id, quoteId).expect(204);
    expect((await residentQuotes(id))[0]).toMatchObject({
      status: 'approved',
      decidedByMe: true,
      mayDecide: false,
    });
    const approved = await notices('ticket.quote_approved', id);
    expect(approved.map((n) => n.accountId)).toEqual(
      expect.arrayContaining([tech().id, s.supervisor.id]),
    );
    await start(id).expect(204);
    expect((await d.ticketRow(s.c, id)).status).toBe('in_progress');
    // Started: no more quotes.
    const late = await propose(id).expect(409);
    expect(code(late)).toBe('TICKET_QUOTE_NOT_ALLOWED');
    expect(params(late)).toEqual({ status: 'in_progress' });
  });

  it('declined: the work does not start until a new quote is approved; withdrawn counts as none', async () => {
    const id = await assigned();
    const first = await quoteOf(id);
    const again = await propose(id).expect(409);
    expect(code(again)).toBe('TICKET_QUOTE_EXISTS');
    const bad = await decline(id, first, 'nope').expect(400);
    expect(code(bad)).toBe('VALIDATION_FAILED');
    await decline(id, first).expect(204);
    expect((await residentQuotes(id))[0]).toMatchObject({
      status: 'declined',
      declineReason: 'too_expensive',
    });
    expect(params(await start(id).expect(409))).toEqual({
      status: 'declined',
    });
    // Decided once.
    const twice = await approve(id, first).expect(409);
    expect(code(twice)).toBe('TICKET_QUOTE_INVALID_TRANSITION');
    expect(params(twice)).toEqual({ status: 'declined' });

    // A new quote, withdrawn by the dispatch: the declined one is still the
    // last decided, so the work still waits.
    const second = await quoteOf(id, { amount: '200' });
    await d
      .http(
        'post',
        `/maintenance/tickets/${id}/quotes/${second}/withdraw`,
        s.supervisor.token,
      )
      .expect(204);
    expect((await notices('ticket.quote_withdrawn', id)).length).toBe(1);
    await start(id).expect(409);
    const third = await quoteOf(id, { amount: '150' });
    await approve(id, third).expect(204);
    await start(id).expect(204);

    // A ticket whose only quote was withdrawn works as before.
    const other = await assigned();
    const withdrawn = await quoteOf(other);
    await d
      .http(
        'post',
        `/maintenance/tickets/${other}/quotes/${withdrawn}/withdraw`,
        s.supervisor.token,
      )
      .expect(204);
    await start(other).expect(204);
  });

  it('only the reporter or the unit’s primary decides; others do not see it', async () => {
    const tenant = await d.x.resident(s.c, [s.unit.id], 'tenant');
    const t = await d.who(s.c, tenant.id, 'resident');
    const res = await d
      .http('post', '/tickets', t.token, {
        unitId: s.unit.id,
        categoryId: await d.categoryId(s.c, 'general'),
        description: 'Quote fixture',
      })
      .expect(201);
    const id = (res.body as { id: string }).id;
    const quoteId = await quoteOf(id);
    // The reporter (a tenant) and the primary are both told and may decide.
    expect(
      (await notices('ticket.quote_proposed', id))
        .map((n) => n.accountId)
        .sort(),
    ).toEqual([s.owner.id, tenant.id].sort());
    expect((await residentQuotes(id, t.token))[0].mayDecide).toBe(true);
    expect((await residentQuotes(id))[0].mayDecide).toBe(true);

    const elsewhere = await d.x.unit(s.c);
    const neighbour = await d.who(
      s.c,
      (await d.x.resident(s.c, [elsewhere.id])).id,
      'resident',
    );
    expect(code(await approve(id, quoteId, neighbour.token).expect(404))).toBe(
      'TICKET_NOT_FOUND',
    );
    // An unknown quote of a visible ticket.
    expect(
      code(
        await approve(id, '0192a5f0-1c2b-7d3e-8f40-0000000058c9').expect(404),
      ),
    ).toBe('TICKET_QUOTE_NOT_FOUND');
    await approve(id, quoteId, t.token).expect(204);
  });

  it('a common-area ticket takes no quote', async () => {
    const res = await d
      .http('post', '/tickets', s.owner.token, {
        commonArea: 'Lobby',
        categoryId: await d.categoryId(s.c, 'general'),
        description: 'Common fixture',
      })
      .expect(201);
    const id = (res.body as { id: string }).id;
    const refused = await propose(id).expect(409);
    expect(code(refused)).toBe('TICKET_QUOTE_NOT_ALLOWED');
  });

  it('a retried decision with its key replays; without, it is a conflict', async () => {
    const id = await assigned();
    const quoteId = await quoteOf(id);
    const key = `quote-${quoteId}`;
    for (let i = 0; i < 2; i++)
      await approve(id, quoteId).set('Idempotency-Key', key).expect(204);
    await approve(id, quoteId).expect(409);
    const other = await assigned();
    const created = await propose(other)
      .set('Idempotency-Key', `propose-${quoteId}`)
      .expect(201);
    const replay = await propose(other)
      .set('Idempotency-Key', `propose-${quoteId}`)
      .expect(201);
    expect(replay.body).toEqual(created.body);
    expect(
      await d.inTenant(s.c, (tx) =>
        tx.ticketQuote.count({ where: { ticketId: other } }),
      ),
    ).toBe(1);
  });

  it('races: an approval against a withdrawal, and against the start (×5)', async () => {
    for (let i = 0; i < 5; i++) {
      const id = await assigned();
      const quoteId = await quoteOf(id);
      const [approved, withdrawn] = await Promise.all([
        approve(id, quoteId).then((r) => r.status),
        d
          .http(
            'post',
            `/maintenance/tickets/${id}/quotes/${quoteId}/withdraw`,
            s.supervisor.token,
          )
          .then((r) => r.status),
      ]);
      expect([approved, withdrawn].sort()).toEqual([204, 409]);
      const row = await d.inTenant(s.c, (tx) =>
        tx.ticketQuote.findUniqueOrThrow({ where: { id: quoteId } }),
      );
      expect(row.status).toBe(approved === 204 ? 'approved' : 'withdrawn');

      // The start wins only after the approval committed.
      const other = await assigned();
      const q = await quoteOf(other);
      const [ok, started] = await Promise.all([
        approve(other, q).then((r) => r.status),
        start(other).then((r) => r.status),
      ]);
      expect(ok).toBe(204);
      const ticket = await d.ticketRow(s.c, other);
      expect(ticket.status).toBe(started === 204 ? 'in_progress' : 'assigned');
      if (started !== 204) expect(started).toBe(409);
    }
  });

  it('the terms never change and a quote is decided once (the database)', async () => {
    const id = await assigned();
    const quoteId = await quoteOf(id);
    await approve(id, quoteId).expect(204);
    await expect(
      d.inTenant(s.c, (tx) =>
        tx.ticketQuote.update({
          where: { id: quoteId },
          data: { amount: '1.00' },
        }),
      ),
    ).rejects.toThrow(/keeps its terms/);
    await expect(
      d.inTenant(s.c, (tx) =>
        tx.ticketQuote.update({
          where: { id: quoteId },
          data: { status: 'declined', declineReason: 'other' },
        }),
      ),
    ).rejects.toThrow(/keeps its terms/);
    await expect(
      d.inTenant(s.c, (tx) =>
        tx.ticketQuote.delete({ where: { id: quoteId } }),
      ),
    ).rejects.toThrow(/keeps its terms/);
  });
});
