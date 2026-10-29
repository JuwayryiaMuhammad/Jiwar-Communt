import { err } from '../api/request';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { operationsHelpers, type OperationsSetUp } from '../setup/operations';

interface Request {
  id: string;
  status: string;
  storeId: string | null;
  reasonCode: string | null;
}
interface Costs {
  data: {
    kind: string;
    quantity: string;
    unitAmount: string;
    amount: string;
    id: string;
  }[];
  totals: { parts: string };
}

/**
 * ADR 0065: a technician's parts for their ticket — asked for while the
 * work is in hand, reserved in a store (held there), issued onto the
 * ticket's costs at the average cost, declined or called off, returned
 * when unused; a cancelled ticket calls its open requests off.
 */
describe('Operations — part requests', () => {
  let h: HttpHarness;
  let o: ReturnType<typeof operationsHelpers>;
  let s: OperationsSetUp;
  let store: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    o = operationsHelpers(h);
    s = await o.setUp(1);
    store = await o.store(s);
  }, 90_000);

  afterAll(() => h.close());

  const tech = () => s.techs[0];
  const request = (ticketId: string, itemId: string, quantity = '1') =>
    o.http(
      'post',
      `/technician/tickets/${ticketId}/part-requests`,
      tech().token,
      {
        itemId,
        quantity,
      },
    );
  const act = (id: string, verb: string, body: object = {}) =>
    o.http(
      'post',
      `/maintenance/part-requests/${id}/${verb}`,
      s.manager.token,
      body,
    );
  const costs = async (ticketId: string) =>
    (
      await o
        .http(
          'get',
          `/maintenance/tickets/${ticketId}/costs`,
          s.supervisor.token,
        )
        .expect(200)
    ).body as Costs;
  const notices = (accountId: string, kind: string) =>
    o.inTenant(s.c, (tx) =>
      tx.notification.findMany({ where: { accountId, kind } }),
    );

  it('asked for, reserved, issued: held, then out of the store and onto the ticket’s costs at the average cost', async () => {
    const item = await o.item(s);
    await o.receive(s, item, store, '4', '10');
    await o.receive(s, item, store, '4', '20');
    const ticket = await o.startedTicket(s);
    const asked = (await request(ticket, item, '3').expect(201))
      .body as Request;
    expect(asked).toMatchObject({ status: 'requested', storeId: null });
    expect(
      (await notices(s.manager.id, 'part_request.created')).some(
        (n) => n.targetId === ticket,
      ),
    ).toBe(true);
    const reserved = (
      await act(asked.id, 'reserve', { storeId: store }).expect(200)
    ).body as Request;
    expect(reserved).toMatchObject({ status: 'reserved', storeId: store });
    expect(await o.card(s, item)).toMatchObject({
      onHand: '8.000',
      reserved: '3.000',
    });
    expect(
      (await notices(tech().id, 'part_request.reserved')).some(
        (n) => n.targetId === ticket,
      ),
    ).toBe(true);

    await act(asked.id, 'issue').expect(200);
    expect(await o.card(s, item)).toMatchObject({
      onHand: '5.000',
      reserved: '0.000',
    });
    const after = await costs(ticket);
    expect(after.data.filter((e) => e.kind === 'part')).toEqual([
      expect.objectContaining({
        quantity: '3.000',
        unitAmount: '15.00',
        amount: '45.00',
      }) as unknown,
    ]);
    // A part's cost is the store's: undone by a return, never voided.
    const part = after.data.find((e) => e.kind === 'part')!;
    expect(
      err(
        await o
          .http(
            'post',
            `/maintenance/ticket-costs/${part.id}/void`,
            s.supervisor.token,
            {
              reasonCode: 'duplicate',
            },
          )
          .expect(409),
      ).code,
    ).toBe('TICKET_COST_ENTRY_IS_PART');
    // Decided once.
    expect(err(await act(asked.id, 'issue').expect(409))).toMatchObject({
      code: 'PART_REQUEST_WRONG_STATUS',
      params: { status: 'issued' },
    });

    // What was not used goes back, at what it was issued at; never more.
    const back = (quantity: string) =>
      o.http(
        'post',
        `/technician/tickets/${ticket}/part-returns`,
        tech().token,
        {
          itemId: item,
          storeId: store,
          quantity,
        },
      );
    await back('1').expect(201);
    expect(err(await back('3').expect(409))).toMatchObject({
      code: 'PART_RETURN_EXCEEDS_ISSUED',
      params: { returnable: '2.000' },
    });
    expect((await costs(ticket)).totals.parts).toBe('30.00');
    expect((await o.card(s, item)).onHand).toBe('6.000');
    const parts = (
      await o
        .http('get', `/technician/tickets/${ticket}/parts`, tech().token)
        .expect(200)
    ).body as { parts: { itemId: string; issued: string; returned: string }[] };
    expect(parts.parts).toEqual([
      expect.objectContaining({
        itemId: item,
        issued: '3.000',
        returned: '1.000',
      }) as unknown,
    ]);
  });

  it('a reservation holds stock from everyone else: two at once for the last units leave one', async () => {
    const item = await o.item(s);
    await o.receive(s, item, store, '2');
    for (let round = 0; round < 3; round++) {
      const t1 = await o.startedTicket(s);
      const t2 = await o.startedTicket(s);
      const a = (await request(t1, item, '2').expect(201)).body as Request;
      const b = (await request(t2, item, '2').expect(201)).body as Request;
      const results = await Promise.all([
        act(a.id, 'reserve', { storeId: store }),
        act(b.id, 'reserve', { storeId: store }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(err(results.find((r) => r.status === 409)!)).toMatchObject({
        code: 'STOCK_INSUFFICIENT',
        params: { available: '0.000' },
      });
      expect((await o.card(s, item)).reserved).toBe('2.000');
      // Let go again for the next round.
      const held = results[0].status === 200 ? a : b;
      const other = held === a ? b : a;
      await o
        .http(
          'post',
          `/technician/part-requests/${held.id}/cancel`,
          tech().token,
          {
            reasonCode: 'not_needed',
          },
        )
        .expect(200);
      await act(other.id, 'decline', { reasonCode: 'out_of_stock' }).expect(
        200,
      );
      expect((await o.card(s, item)).reserved).toBe('0.000');
    }
  });

  it('an issue racing a decline: one decides; stock and costs follow the winner', async () => {
    const item = await o.item(s);
    await o.receive(s, item, store, '5');
    for (let round = 0; round < 3; round++) {
      const ticket = await o.startedTicket(s);
      const r = (await request(ticket, item).expect(201)).body as Request;
      await act(r.id, 'reserve', { storeId: store }).expect(200);
      const before = await o.card(s, item);
      const results = await Promise.all([
        act(r.id, 'issue'),
        act(r.id, 'decline', { reasonCode: 'wrong_part' }),
      ]);
      expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
      const row = await o.inTenant(s.c, (tx) =>
        tx.partRequest.findUniqueOrThrow({ where: { id: r.id } }),
      );
      const after = await o.card(s, item);
      expect(after.reserved).toBe((Number(before.reserved) - 1).toFixed(3));
      const parts = (await costs(ticket)).data.filter((e) => e.kind === 'part');
      if (row.status === 'issued') {
        expect(after.onHand).toBe((Number(before.onHand) - 1).toFixed(3));
        expect(parts).toHaveLength(1);
      } else {
        expect(row.status).toBe('declined');
        expect(after.onHand).toBe(before.onHand);
        expect(parts).toHaveLength(0);
      }
    }
  });

  it('declined with a reason, the technician told; called off by them only while open', async () => {
    const item = await o.item(s);
    await o.receive(s, item, store, '1');
    const ticket = await o.startedTicket(s);
    const r = (await request(ticket, item).expect(201)).body as Request;
    expect(err(await act(r.id, 'decline').expect(400)).code).toBe(
      'REASON_REQUIRED',
    );
    await act(r.id, 'decline', { reasonCode: 'not_needed' }).expect(200);
    const told = (await notices(tech().id, 'part_request.declined')).filter(
      (n) => n.targetId === ticket,
    );
    expect(told.map((n) => n.params)).toEqual([
      expect.objectContaining({ reason: 'not_needed' }) as unknown,
    ]);
    expect(
      err(
        await o
          .http(
            'post',
            `/technician/part-requests/${r.id}/cancel`,
            tech().token,
            {
              reasonCode: 'not_needed',
            },
          )
          .expect(409),
      ).code,
    ).toBe('PART_REQUEST_WRONG_STATUS');
    // The database keeps a closed request as it closed.
    await expect(
      o.inTenant(s.c, (tx) =>
        tx.partRequest.update({
          where: { id: r.id },
          data: { status: 'reserved' },
        }),
      ),
    ).rejects.toThrow(/moves forward once/);
  });

  it('only while the work is in hand, only for an active item; a cancelled ticket calls its requests off', async () => {
    const item = await o.item(s);
    await o.receive(s, item, store, '3');
    const ticket = await o.startedTicket(s);
    const r = (await request(ticket, item, '2').expect(201)).body as Request;
    await act(r.id, 'reserve', { storeId: store }).expect(200);
    const open = (await request(ticket, item).expect(201)).body as Request;
    await o
      .http(
        'post',
        `/maintenance/tickets/${ticket}/cancel`,
        s.supervisor.token,
        {
          reasonCode: 'duplicate',
        },
      )
      .expect(204);
    const rows = await o.inTenant(s.c, (tx) =>
      tx.partRequest.findMany({ where: { id: { in: [r.id, open.id] } } }),
    );
    expect(rows.map((x) => [x.status, x.reasonCode])).toEqual([
      ['cancelled', 'not_needed'],
      ['cancelled', 'not_needed'],
    ]);
    expect((await o.card(s, item)).reserved).toBe('0.000');

    const done = await o.startedTicket(s);
    await o
      .http('post', `/technician/tickets/${done}/complete`, tech().token)
      .expect(204);
    expect(err(await request(done, item).expect(409))).toMatchObject({
      code: 'TICKET_NOT_TAKING_PARTS',
      params: { status: 'completed' },
    });
    const live = await o.startedTicket(s);
    await o
      .http('patch', `/maintenance/stock/items/${item}`, s.manager.token, {
        active: false,
      })
      .expect(200);
    expect(err(await request(live, item).expect(409)).code).toBe(
      'STOCK_ITEM_RETIRED',
    );
  });
});
