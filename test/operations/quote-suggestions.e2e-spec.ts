import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { TicketsService } from '../../src/maintenance/tickets/tickets.service';
import { err } from '../api/request';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { operationsHelpers, type OperationsSetUp } from '../setup/operations';

interface Suggestion {
  id: string;
  status: string;
  amount: string;
  quoteId: string | null;
  dismissReason: string | null;
}

/**
 * ADR 0065: a price the technician found on site, sent by dispatch as the
 * ticket's quote (ADR 0058) or dismissed, once. The residents only ever
 * see the quote.
 */
describe('Operations — the technician’s suggested quotes', () => {
  let h: HttpHarness;
  let o: ReturnType<typeof operationsHelpers>;
  let s: OperationsSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    o = operationsHelpers(h);
    s = await o.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  const suggest = (id: string, body: object = { amount: '350' }) =>
    o.http(
      'post',
      `/technician/tickets/${id}/quote-suggestions`,
      s.techs[0].token,
      body,
    );
  const notices = (accountId: string, ticketId: string) =>
    o.inTenant(s.c, (tx) =>
      tx.notification.findMany({
        where: { accountId, targetId: ticketId },
        orderBy: { createdAt: 'asc' },
      }),
    );

  it('suggested once per ticket, dispatch told; sent as the quote the residents approve', async () => {
    const id = await o.assignedTicket(s);
    const made = (
      await suggest(id, {
        amount: '350',
        note: 'New mixer tap and fitting',
      }).expect(201)
    ).body as Suggestion;
    expect(made).toMatchObject({
      status: 'pending',
      amount: '350.00',
      quoteId: null,
    });
    expect(err(await suggest(id, { amount: '400' }).expect(409)).code).toBe(
      'QUOTE_SUGGESTION_EXISTS',
    );
    expect(
      (await notices(s.supervisor.id, id)).map((n) => [n.kind, n.params]),
    ).toEqual([
      ['ticket.quote_suggested', expect.objectContaining({ amount: '350.00' })],
    ]);
    // The residents see nothing of it yet.
    const before = (
      await o.http('get', `/tickets/${id}/quotes`, s.owner.token).expect(200)
    ).body as { data: unknown[] };
    expect(before.data).toEqual([]);

    const sent = (
      await o
        .http(
          'post',
          `/maintenance/quote-suggestions/${made.id}/send`,
          s.supervisor.token,
          {
            amount: '375.50',
          },
        )
        .expect(200)
    ).body as Suggestion;
    expect(sent).toMatchObject({
      status: 'sent',
      quoteId: expect.any(String) as string,
    });
    const quotes = (
      await o.http('get', `/tickets/${id}/quotes`, s.owner.token).expect(200)
    ).body as { data: { id: string; amount: string; note: string | null }[] };
    expect(quotes.data).toEqual([
      expect.objectContaining({
        id: sent.quoteId,
        amount: '375.50',
        note: 'New mixer tap and fitting',
      }) as unknown,
    ]);
    await o
      .http(
        'post',
        `/tickets/${id}/quotes/${sent.quoteId}/approve`,
        s.owner.token,
      )
      .expect((r) => expect(r.status).toBeLessThan(300));
    // Decided once.
    expect(
      err(
        await o
          .http(
            'post',
            `/maintenance/quote-suggestions/${made.id}/dismiss`,
            s.supervisor.token,
            {
              reasonCode: 'not_needed',
            },
          )
          .expect(409),
      ),
    ).toMatchObject({
      code: 'QUOTE_SUGGESTION_DECIDED',
      params: { status: 'sent' },
    });
  });

  it('dismissed with a reason; the technician is told which, and may suggest again', async () => {
    const id = await o.assignedTicket(s);
    const made = (await suggest(id).expect(201)).body as Suggestion;
    const dismissed = (
      await o
        .http(
          'post',
          `/maintenance/quote-suggestions/${made.id}/dismiss`,
          s.supervisor.token,
          {
            reasonCode: 'covered_by_contract',
          },
        )
        .expect(200)
    ).body as Suggestion;
    expect(dismissed).toMatchObject({
      status: 'dismissed',
      dismissReason: 'covered_by_contract',
    });
    expect(
      (await notices(s.techs[0].id, id))
        .filter((n) => n.kind === 'ticket.quote_suggestion_dismissed')
        .map((n) => n.params),
    ).toEqual([expect.objectContaining({ reason: 'covered_by_contract' })]);
    await suggest(id, { amount: '200' }).expect(201);
  });

  it('a send racing a dismissal: one decides, the other is told it is decided', async () => {
    for (let round = 0; round < 3; round++) {
      const id = await o.assignedTicket(s);
      const made = (await suggest(id).expect(201)).body as Suggestion;
      const results = await Promise.all([
        o.http(
          'post',
          `/maintenance/quote-suggestions/${made.id}/send`,
          s.supervisor.token,
          {},
        ),
        o.http(
          'post',
          `/maintenance/quote-suggestions/${made.id}/dismiss`,
          s.manager.token,
          {
            reasonCode: 'amount_wrong',
          },
        ),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const quotes = await o.inTenant(s.c, (tx) =>
        tx.ticketQuote.count({ where: { ticketId: id } }),
      );
      const row = await o.inTenant(s.c, (tx) =>
        tx.ticketQuoteSuggestion.findUniqueOrThrow({ where: { id: made.id } }),
      );
      expect(quotes).toBe(row.status === 'sent' ? 1 : 0);
    }
  });

  it('only where dispatch may quote: not once the work started, not on the compound’s own work orders', async () => {
    const started = await o.startedTicket(s);
    expect(err(await suggest(started).expect(409)).code).toBe(
      'TICKET_QUOTE_NOT_ALLOWED',
    );
    // A pending suggestion is not sent once the work started either.
    const id = await o.assignedTicket(s);
    const made = (await suggest(id).expect(201)).body as Suggestion;
    await o
      .http('post', `/technician/tickets/${id}/start`, s.techs[0].token)
      .expect(204);
    expect(
      err(
        await o
          .http(
            'post',
            `/maintenance/quote-suggestions/${made.id}/send`,
            s.supervisor.token,
            {},
          )
          .expect(409),
      ).code,
    ).toBe('TICKET_QUOTE_NOT_ALLOWED');

    // A fault the technician found on an asset: the compound's own work.
    const assetId = await o.asset(s);
    const categoryId = await o.categoryId(s.c, 'plumbing');
    const workOrder = await o.x.asManager(s.c, () =>
      h.moduleRef.get(TenantTx).withTenantTx((tx) =>
        h.moduleRef.get(TicketsService).createWorkOrder(tx, {
          tenantId: s.c.tenantId,
          origin: 'field',
          assetId,
          categoryId,
          priority: 'normal',
          description: 'Field fault',
          responsibleId: s.techs[0].id,
          actorId: s.techs[0].id,
        }),
      ),
    );
    await o
      .http(
        'post',
        `/maintenance/tickets/${workOrder.id}/assign`,
        s.supervisor.token,
        {
          technicianId: s.techs[0].id,
        },
      )
      .expect((r) => expect([200, 201, 204]).toContain(r.status));
    expect(err(await suggest(workOrder.id).expect(409)).code).toBe(
      'TICKET_QUOTE_NOT_ALLOWED',
    );
  });

  it('each side’s routes: dispatch cannot suggest, residents cannot read suggestions', async () => {
    const id = await o.assignedTicket(s);
    await o
      .http(
        'post',
        `/technician/tickets/${id}/quote-suggestions`,
        s.supervisor.token,
        {
          amount: '10',
        },
      )
      .expect(403);
    await o
      .http(
        'get',
        `/maintenance/tickets/${id}/quote-suggestions`,
        s.owner.token,
      )
      .expect(403);
  });
});
