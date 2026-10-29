import { assetHelpers } from './assets';
import { uniqueSuffix } from './fixtures';
import type { HttpHarness } from './http-app';

/**
 * Helpers for the maintenance operations suites (ADR 0065): the asset
 * set-up with automatic dispatch off and its technicians specialized in
 * the general and plumbing categories and available, and a resident's
 * ticket assigned to one of them; the store's rows over HTTP as the
 * manager.
 */
export function operationsHelpers(h: HttpHarness) {
  const a = assetHelpers(h);

  async function setUp(technicians = 1) {
    const s = await a.setUp(technicians);
    // Tickets go to whom a suite assigns them, never by the engine.
    await a.setAutoDispatch(s.c, false);
    for (const tech of s.techs) {
      await a.specialize(s, tech, ['general', 'plumbing']);
      await a.setAvailability(s.c, tech.id, 'available');
    }
    return s;
  }
  type SetUp = Awaited<ReturnType<typeof setUp>>;

  /** A resident's unit ticket, assigned to a technician; its id. */
  async function assignedTicket(s: SetUp, tech = 0): Promise<string> {
    const id = await a.openTicket(s);
    await a
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: s.techs[tech].id,
      })
      .expect((r) => expect([200, 201, 204]).toContain(r.status));
    return id;
  }

  /** The assigned ticket, started; its id. */
  async function startedTicket(s: SetUp, tech = 0): Promise<string> {
    const id = await assignedTicket(s, tech);
    await a
      .http('post', `/technician/tickets/${id}/start`, s.techs[tech].token)
      .expect(204);
    return id;
  }

  /** A store of the compound, over HTTP as the manager; its id. */
  async function store(s: SetUp): Promise<string> {
    const res = await a
      .http('post', '/maintenance/stores', s.manager.token, {
        code: `ST-${uniqueSuffix()}`,
        nameAr: 'مخزن',
        nameEn: 'Store',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  /** A stock item, with a reorder level if given; its id. */
  async function item(s: SetUp, reorderLevel?: string): Promise<string> {
    const res = await a
      .http('post', '/maintenance/stock/items', s.manager.token, {
        sku: `SKU-${uniqueSuffix()}`,
        nameAr: 'صمام',
        nameEn: 'Valve',
        unit: 'piece',
        ...(reorderLevel ? { reorderLevel } : {}),
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  /** Receives `quantity` of an item into a store at `unitCost`. */
  const receive = (
    s: SetUp,
    itemId: string,
    storeId: string,
    quantity: string,
    unitCost = '10',
  ) =>
    a
      .http(
        'post',
        `/maintenance/stock/items/${itemId}/receive`,
        s.manager.token,
        {
          storeId,
          quantity,
          unitCost,
        },
      )
      .expect(201);

  /** The item's card: totals and each store's level. */
  const card = async (s: SetUp, itemId: string) =>
    (
      await a
        .http('get', `/maintenance/stock/items/${itemId}`, s.manager.token)
        .expect(200)
    ).body as {
      onHand: string;
      reserved: string;
      averageCost: string | null;
      belowReorderLevel: boolean;
      levels: { store: { id: string }; quantity: string; reserved: string }[];
    };

  return {
    ...a,
    setUp,
    assignedTicket,
    startedTicket,
    store,
    item,
    receive,
    card,
  };
}

export type OperationsSetUp = Awaited<
  ReturnType<ReturnType<typeof operationsHelpers>['setUp']>
>;
