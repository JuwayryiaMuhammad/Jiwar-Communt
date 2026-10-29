import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { OPERATIONS_COVERAGE } from '../setup/audit-coverage-split';
import type { Compound } from '../setup/community';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { operationsHelpers, type OperationsSetUp } from '../setup/operations';

/**
 * One scenario per entry of the operations catalog (ADR 0014, 0065):
 * actor, target, changes and metadata, and never what an entry, a note or
 * a vendor's contact says.
 */
const covered = new Set<string>();

describe('Audit coverage — maintenance operations', () => {
  let h: HttpHarness;
  let o: ReturnType<typeof operationsHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: OperationsSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    o = operationsHelpers(h);
    read = auditReaders(h);
    s = await o.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  async function single(c: Compound, action: string, targetId: string) {
    const rows = await read.tenant(c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    return rows[0];
  }

  describe('a ticket’s costs', () => {
    it('ticket_cost.recorded and .voided — amounts and codes, never the description', async () => {
      const ticketId = await o.assignedTicket(s);
      const entry = (
        await o
          .http(
            'post',
            `/maintenance/tickets/${ticketId}/costs`,
            s.supervisor.token,
            {
              kind: 'contractor',
              description: 'AUDIT-secret Ahmed the plumber',
              quantity: '2',
              unitAmount: '125.50',
            },
          )
          .expect(201)
      ).body as { id: string };
      const recorded = await single(s.c, 'ticket_cost.recorded', entry.id);
      expect(recorded).toMatchObject({
        actorId: s.supervisor.id,
        changes: {
          ticketId: { from: null, to: ticketId },
          kind: { from: null, to: 'contractor' },
          description: { changed: true },
          quantity: { from: null, to: '2.000' },
          unitAmount: { from: null, to: '125.50' },
          amount: { from: null, to: '251.00' },
        },
      });
      await o
        .http(
          'post',
          `/maintenance/ticket-costs/${entry.id}/void`,
          s.supervisor.token,
          {
            reasonCode: 'duplicate',
          },
        )
        .expect(200);
      const voided = await single(s.c, 'ticket_cost.voided', entry.id);
      expect(voided.metadata).toEqual({ ticketId, reasonCode: 'duplicate' });
      for (const row of [recorded, voided])
        expect(JSON.stringify(row)).not.toContain('AUDIT-secret');
    });
  });

  describe('suggested quotes', () => {
    it('quote_suggestion.made, .sent and .dismissed — the amount and codes, never the note', async () => {
      const one = await o.assignedTicket(s);
      const made = (
        await o
          .http(
            'post',
            `/technician/tickets/${one}/quote-suggestions`,
            s.techs[0].token,
            {
              amount: '90',
              note: 'AUDIT-secret new washer',
            },
          )
          .expect(201)
      ).body as { id: string };
      const suggested = await single(s.c, 'quote_suggestion.made', made.id);
      expect(suggested).toMatchObject({
        actorId: s.techs[0].id,
        changes: {
          ticketId: { from: null, to: one },
          amount: { from: null, to: '90.00' },
          note: { changed: true },
        },
      });
      const sent = (
        await o
          .http(
            'post',
            `/maintenance/quote-suggestions/${made.id}/send`,
            s.supervisor.token,
            {
              amount: '95',
            },
          )
          .expect(200)
      ).body as { quoteId: string };
      const sentRow = await single(s.c, 'quote_suggestion.sent', made.id);
      expect(sentRow.metadata).toEqual({
        ticketId: one,
        quoteId: sent.quoteId,
        amended: true,
      });

      const two = await o.assignedTicket(s);
      const other = (
        await o
          .http(
            'post',
            `/technician/tickets/${two}/quote-suggestions`,
            s.techs[0].token,
            {
              amount: '40',
            },
          )
          .expect(201)
      ).body as { id: string };
      await o
        .http(
          'post',
          `/maintenance/quote-suggestions/${other.id}/dismiss`,
          s.supervisor.token,
          {
            reasonCode: 'not_needed',
          },
        )
        .expect(200);
      const dismissed = await single(
        s.c,
        'quote_suggestion.dismissed',
        other.id,
      );
      expect(dismissed.metadata).toEqual({
        ticketId: two,
        reasonCode: 'not_needed',
      });
      for (const row of [suggested, sentRow, dismissed])
        expect(JSON.stringify(row)).not.toContain('AUDIT-secret');
    });
  });

  describe('the store', () => {
    it('store.* and stock_item.* — codes, units, levels; names as changed only', async () => {
      const store = (
        await o
          .http('post', '/maintenance/stores', s.manager.token, {
            code: `AUD-${Date.now()}`,
            nameAr: 'مخزن',
            nameEn: 'AUDIT-secret basement',
          })
          .expect(201)
      ).body as { id: string; code: string };
      const made = await single(s.c, 'store.created', store.id);
      expect(made.changes).toMatchObject({
        code: { from: null, to: store.code },
        nameEn: { changed: true },
        active: { from: null, to: true },
      });
      await o
        .http('patch', `/maintenance/stores/${store.id}`, s.manager.token, {
          nameEn: 'AUDIT-secret attic',
          active: false,
        })
        .expect(200);
      expect((await single(s.c, 'store.updated', store.id)).changes).toEqual({
        nameEn: { changed: true },
        active: { from: true, to: false },
      });
      const item = (
        await o
          .http('post', '/maintenance/stock/items', s.manager.token, {
            sku: `AUD-${Date.now()}`,
            nameAr: 'صمام',
            nameEn: 'AUDIT-secret valve',
            unit: 'piece',
          })
          .expect(201)
      ).body as { id: string; sku: string };
      expect(
        (await single(s.c, 'stock_item.created', item.id)).changes,
      ).toMatchObject({
        sku: { from: null, to: item.sku },
        unit: { from: null, to: 'piece' },
        nameEn: { changed: true },
      });
      await o
        .http('patch', `/maintenance/stock/items/${item.id}`, s.manager.token, {
          reorderLevel: '4',
        })
        .expect(200);
      expect(
        (await single(s.c, 'stock_item.updated', item.id)).changes,
      ).toEqual({
        reorderLevel: { from: null, to: '4.000' },
      });
      const rows = await read.tenant(s.c.tenantId, { targetId: item.id });
      expect(JSON.stringify(rows)).not.toContain('AUDIT-secret');
    });

    it('stock.received, .adjusted, .transferred and .returned; part_request.* — quantities, costs, stores, codes', async () => {
      const [a, b] = [await o.store(s), await o.store(s)];
      const item = await o.item(s);
      await o
        .http(
          'post',
          `/maintenance/stock/items/${item}/receive`,
          s.manager.token,
          {
            storeId: a,
            quantity: '6',
            unitCost: '12.5',
            reference: 'AUDIT-secret DN',
          },
        )
        .expect(201);
      const received = await single(s.c, 'stock.received', item);
      expect(received.metadata).toEqual({
        storeId: a,
        quantity: '6.000',
        unitCost: '12.50',
        averageCost: '12.50',
        hasReference: true,
      });
      expect(JSON.stringify(received)).not.toContain('AUDIT-secret');
      await o
        .http(
          'post',
          `/maintenance/stock/items/${item}/adjust`,
          s.manager.token,
          {
            storeId: a,
            delta: '-1',
            reasonCode: 'damaged',
          },
        )
        .expect(201);
      expect((await single(s.c, 'stock.adjusted', item)).metadata).toEqual({
        storeId: a,
        quantity: '-1.000',
        reasonCode: 'damaged',
      });
      await o
        .http(
          'post',
          `/maintenance/stock/items/${item}/transfer`,
          s.manager.token,
          {
            fromStoreId: a,
            toStoreId: b,
            quantity: '1',
          },
        )
        .expect(201);
      expect((await single(s.c, 'stock.transferred', item)).metadata).toEqual({
        fromStoreId: a,
        toStoreId: b,
        quantity: '1.000',
      });

      const ticket = await o.startedTicket(s);
      const ask = async (quantity: string) =>
        (
          (
            await o
              .http(
                'post',
                `/technician/tickets/${ticket}/part-requests`,
                s.techs[0].token,
                {
                  itemId: item,
                  quantity,
                },
              )
              .expect(201)
          ).body as { id: string }
        ).id;
      const one = await ask('2');
      expect(
        (await single(s.c, 'part_request.requested', one)).metadata,
      ).toEqual({
        ticketId: ticket,
        itemId: item,
        quantity: '2.000',
      });
      await o
        .http(
          'post',
          `/maintenance/part-requests/${one}/reserve`,
          s.manager.token,
          { storeId: a },
        )
        .expect(200);
      expect(
        (await single(s.c, 'part_request.reserved', one)).metadata,
      ).toEqual({
        ticketId: ticket,
        itemId: item,
        quantity: '2.000',
        storeId: a,
      });
      await o
        .http(
          'post',
          `/maintenance/part-requests/${one}/issue`,
          s.manager.token,
        )
        .expect(200);
      expect(
        (await single(s.c, 'part_request.issued', one)).metadata,
      ).toMatchObject({
        storeId: a,
      });
      await o
        .http(
          'post',
          `/technician/tickets/${ticket}/part-returns`,
          s.techs[0].token,
          {
            itemId: item,
            storeId: b,
            quantity: '1',
          },
        )
        .expect(201);
      expect((await single(s.c, 'stock.returned', item)).metadata).toEqual({
        ticketId: ticket,
        storeId: b,
        quantity: '1.000',
      });
      const two = await ask('1');
      await o
        .http(
          'post',
          `/maintenance/part-requests/${two}/decline`,
          s.manager.token,
          {
            reasonCode: 'out_of_stock',
          },
        )
        .expect(200);
      expect(
        (await single(s.c, 'part_request.declined', two)).metadata,
      ).toMatchObject({
        reasonCode: 'out_of_stock',
      });
      const three = await ask('1');
      await o
        .http(
          'post',
          `/technician/part-requests/${three}/cancel`,
          s.techs[0].token,
          {
            reasonCode: 'found_elsewhere',
          },
        )
        .expect(200);
      expect((await single(s.c, 'part_request.cancelled', three)).actorId).toBe(
        s.techs[0].id,
      );
    });
  });

  describe('catalog completeness', () => {
    it('every operations entry has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of OPERATIONS_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...OPERATIONS_COVERAGE].sort());
    });
  });
});
