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

  describe('catalog completeness', () => {
    it('every operations entry has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of OPERATIONS_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...OPERATIONS_COVERAGE].sort());
    });
  });
});
