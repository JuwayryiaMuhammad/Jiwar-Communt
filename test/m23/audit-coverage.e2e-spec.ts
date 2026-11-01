import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { M23_COVERAGE } from '../setup/audit-coverage-split';
import { boardMatterHelpers } from '../setup/board-matters';
import { batchRow, disputeRow, invoiceRow } from '../setup/finance-rows';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const MARKER = 'AUDIT-m23-secret';

/**
 * One scenario per entry of the staff inbox's, the authority's and the
 * deputies' catalog (ADR 0014, 0073): actor, target, and what changed —
 * types, hours, amounts, permissions and days, never a person's words.
 */
const covered = new Set<string>();

describe('Audit coverage — the inbox, the authority and the deputies', () => {
  let h: HttpHarness;
  let b: ReturnType<typeof boardMatterHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: Awaited<ReturnType<ReturnType<typeof boardMatterHelpers>['setUp']>>;
  const o = (i: number) => s.owners[i - 1];

  beforeAll(async () => {
    h = await createHttpHarness();
    b = boardMatterHelpers(h);
    read = auditReaders(h);
    s = await b.setUp(4, 3);
  }, 90_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const rows = await read.tenant(s.c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    expect(JSON.stringify(rows[0])).not.toContain(MARKER);
    return rows[0];
  }

  describe('the staff inbox', () => {
    it('staff_inbox.settings_changed — each type’s due hours, from and to', async () => {
      await b
        .http('patch', '/staff/inbox/settings', s.manager.token, {
          items: [{ type: 'vehicle', dueHours: 12 }],
        })
        .expect(200);
      expect(
        await single('staff_inbox.settings_changed', s.c.tenantId),
      ).toMatchObject({
        actorId: s.manager.id,
        changes: { 'vehicle.dueHours': { from: 72, to: 12 } },
      });
    });
  });

  describe('the board’s authority', () => {
    it('board_authorization.granted and .used — the request, the type and the amounts; what used it', async () => {
      await b
        .http('patch', '/staff/governance/settings', s.manager.token, {
          items: [
            { type: 'waiver_above_limit', threshold: '100.00', binding: true },
          ],
        })
        .expect(200);
      const r = await b.raise(s.manager, {
        type: 'waiver_above_limit',
        context: MARKER,
        cost: '700.00',
      });
      const m = await b.motion(o(1), r.id);
      await b.vote(o(1), m.id, 'for').expect(201);
      await b.vote(o(2), m.id, 'for').expect(201);
      const [auth] = (
        (
          await b
            .http(
              'get',
              '/staff/finance/board-authorizations?unused=true',
              s.manager.token,
            )
            .expect(200)
        ).body as { data: { id: string }[] }
      ).data;
      expect(
        await single('board_authorization.granted', auth.id),
      ).toMatchObject({
        metadata: {
          requestId: r.id,
          type: 'waiver_above_limit',
          amount: '700.00',
        },
      });
      const owner = o(4);
      const disputeId = await b.inTx(s.c, async (tx) => {
        const batchId = await batchRow(tx, {
          tenantId: s.c.tenantId,
          unitId: owner.unitId,
          createdById: s.c.managerId,
        });
        const invoiceId = await invoiceRow(tx, {
          tenantId: s.c.tenantId,
          unitId: owner.unitId,
          batchId,
          createdById: s.c.managerId,
          total: '1000.00',
        });
        return disputeRow(tx, {
          tenantId: s.c.tenantId,
          unitId: owner.unitId,
          invoiceId,
          openedById: owner.id,
        });
      });
      await b
        .http(
          'post',
          `/staff/invoice-disputes/${disputeId}/decide`,
          s.manager.token,
          { decision: 'accept', amount: '600.00', authorizationId: auth.id },
        )
        .expect(201);
      expect(await single('board_authorization.used', auth.id)).toMatchObject({
        actorId: s.manager.id,
        metadata: {
          type: 'waiver_above_limit',
          amount: '600.00',
          usedByType: 'invoice_dispute',
          usedById: disputeId,
        },
      });
    });
  });

  describe('catalog completeness', () => {
    it('every entry of the phase has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of M23_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...M23_COVERAGE].sort());
    });
  });
});
