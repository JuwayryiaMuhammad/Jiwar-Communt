import { newId } from '../../src/core/common/uuid';
import { err } from '../api/request';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { operationsHelpers, type OperationsSetUp } from '../setup/operations';

interface Movement {
  id: string;
  kind: string;
  quantity: string;
  transferId: string | null;
}

/**
 * ADR 0065: the maintenance store — receipts at their cost (the average
 * follows), adjustments with a reason, transfers between stores, never a
 * level below zero or below what is reserved, a reorder warning once per
 * fall, and a catalogue that tells a technician only whether some is free.
 */
describe('Operations — the maintenance store', () => {
  let h: HttpHarness;
  let o: ReturnType<typeof operationsHelpers>;
  let s: OperationsSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    o = operationsHelpers(h);
    s = await o.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  const adjust = (itemId: string, body: object) =>
    o.http(
      'post',
      `/maintenance/stock/items/${itemId}/adjust`,
      s.manager.token,
      body,
    );

  it('receipts fill a store and move the average cost; a replay writes nothing more', async () => {
    const store = await o.store(s);
    const item = await o.item(s);
    await o.receive(s, item, store, '10', '5');
    const key = newId();
    const receipt = (
      await o
        .http(
          'post',
          `/maintenance/stock/items/${item}/receive`,
          s.manager.token,
          {
            storeId: store,
            quantity: '30',
            unitCost: '9',
            reference: 'DN-1042',
          },
        )
        .set('Idempotency-Key', key)
        .expect(201)
    ).body as Movement;
    const replay = (
      await o
        .http(
          'post',
          `/maintenance/stock/items/${item}/receive`,
          s.manager.token,
          {
            storeId: store,
            quantity: '30',
            unitCost: '9',
            reference: 'DN-1042',
          },
        )
        .set('Idempotency-Key', key)
        .expect(201)
    ).body as Movement;
    expect(replay.id).toBe(receipt.id);
    expect(await o.card(s, item)).toMatchObject({
      onHand: '40.000',
      reserved: '0.000',
      averageCost: '8.00',
    });
    // Technicians and residents do not keep the store.
    await o
      .http('get', `/maintenance/stock/items/${item}`, s.techs[0].token)
      .expect(403);
    await o.http('get', '/maintenance/stores', s.owner.token).expect(403);
  });

  it('an adjustment needs a reason and never takes a level below zero, even two at once', async () => {
    const store = await o.store(s);
    const item = await o.item(s);
    await o.receive(s, item, store, '3');
    expect(
      err(await adjust(item, { storeId: store, delta: '-1' }).expect(400)).code,
    ).toBe('REASON_REQUIRED');
    const results = await Promise.all(
      [1, 2].map(() =>
        adjust(item, { storeId: store, delta: '-2', reasonCode: 'damaged' }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(err(results.find((r) => r.status === 409)!)).toMatchObject({
      code: 'STOCK_INSUFFICIENT',
      params: { available: '1.000' },
    });
    expect((await o.card(s, item)).onHand).toBe('1.000');
    await adjust(item, {
      storeId: store,
      delta: '0.5',
      reasonCode: 'found',
    }).expect(201);
    expect((await o.card(s, item)).onHand).toBe('1.500');
  });

  it('a transfer is a pair of movements; never to the same store, never out of a retired one', async () => {
    const [a, b] = [await o.store(s), await o.store(s)];
    const item = await o.item(s);
    await o.receive(s, item, a, '5');
    const transfer = (to: string, quantity = '2') =>
      o.http(
        'post',
        `/maintenance/stock/items/${item}/transfer`,
        s.manager.token,
        {
          fromStoreId: a,
          toStoreId: to,
          quantity,
        },
      );
    expect(err(await transfer(a).expect(400)).fields).toEqual([
      { field: 'toStoreId', code: 'INVALID_VALUE' },
    ]);
    const out = (await transfer(b).expect(201)).body as Movement;
    expect(out).toMatchObject({ kind: 'transfer', quantity: '-2.000' });
    const pair = (
      await o
        .http(
          'get',
          `/maintenance/stock/movements?itemId=${item}&limit=50`,
          s.manager.token,
        )
        .expect(200)
    ).body as { data: Movement[] };
    expect(
      pair.data
        .filter((m) => m.transferId === out.transferId)
        .map((m) => m.quantity)
        .sort(),
    ).toEqual(['-2.000', '2.000']);
    const card = await o.card(s, item);
    expect(card.levels.map((l) => [l.store.id, l.quantity]).sort()).toEqual(
      [
        [a, '3.000'],
        [b, '2.000'],
      ].sort(),
    );
    await o
      .http('patch', `/maintenance/stores/${a}`, s.manager.token, {
        active: false,
      })
      .expect(200);
    expect(err(await transfer(b, '1').expect(409)).code).toBe('STORE_RETIRED');
    // Movements are history: never edited.
    await expect(
      o.inTenant(s.c, (tx) =>
        tx.stockMovement.update({
          where: { id: out.id },
          data: { quantity: '-1' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('the reorder warning: once as stock falls to the level, cleared as it rises, again on the next fall', async () => {
    const store = await o.store(s);
    const item = await o.item(s, '2');
    await o.receive(s, item, store, '5');
    const warnings = () =>
      o.inTenant(s.c, (tx) =>
        tx.notification.count({
          where: {
            accountId: s.manager.id,
            kind: 'stock.reorder_level',
            targetId: item,
          },
        }),
      );
    expect(await warnings()).toBe(0);
    await adjust(item, {
      storeId: store,
      delta: '-3',
      reasonCode: 'count_correction',
    }).expect(201);
    expect(await warnings()).toBe(1);
    expect((await o.card(s, item)).belowReorderLevel).toBe(true);
    await adjust(item, {
      storeId: store,
      delta: '-1',
      reasonCode: 'lost',
    }).expect(201);
    expect(await warnings()).toBe(1);
    await o.receive(s, item, store, '4');
    expect((await o.card(s, item)).belowReorderLevel).toBe(false);
    await adjust(item, {
      storeId: store,
      delta: '-3',
      reasonCode: 'expired',
    }).expect(201);
    expect(await warnings()).toBe(2);
    const listed = (
      await o
        .http(
          'get',
          '/maintenance/stock/items?below=true&limit=100',
          s.manager.token,
        )
        .expect(200)
    ).body as { data: { id: string }[] };
    expect(listed.data.map((i) => i.id)).toContain(item);
  });

  it('the technicians’ catalogue says whether some is free — never how much, never where', async () => {
    const store = await o.store(s);
    const stocked = await o.item(s);
    const empty = await o.item(s);
    await o.receive(s, stocked, store, '7');
    const seen = (
      await o
        .http('get', '/technician/stock/items?limit=100', s.techs[0].token)
        .expect(200)
    ).body as { data: { id: string; available: boolean }[] };
    const of = (id: string) => seen.data.find((i) => i.id === id);
    expect(of(stocked)?.available).toBe(true);
    expect(of(empty)?.available).toBe(false);
    expect(Object.keys(of(stocked)!).sort()).toEqual(
      ['available', 'id', 'nameAr', 'nameEn', 'sku', 'unit'].sort(),
    );
    // A retired item is not offered.
    await o
      .http('patch', `/maintenance/stock/items/${empty}`, s.manager.token, {
        active: false,
      })
      .expect(200);
    const again = (
      await o
        .http('get', '/technician/stock/items?limit=100', s.techs[0].token)
        .expect(200)
    ).body as { data: { id: string }[] };
    expect(again.data.map((i) => i.id)).not.toContain(empty);
  });
});
