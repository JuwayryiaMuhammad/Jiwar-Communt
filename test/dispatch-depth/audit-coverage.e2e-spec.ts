import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { addDays } from '../../src/maintenance/schedules/local-dates';
import { auditReaders } from '../setup/audit';
import { assetHelpers, type AssetSetUp } from '../setup/assets';
import { M22_COVERAGE } from '../setup/audit-coverage-split';
import { today } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const MARKER = 'AUDIT-m22-secret';

/**
 * One scenario per entry of dispatch depth's catalog (ADR 0014, 0076):
 * actor, target and metadata — codes, ids and cycles, never staff's or
 * residents' words.
 */
const covered = new Set<string>();

describe('Audit coverage — dispatch depth', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof assetHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: AssetSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = assetHelpers(h);
    read = auditReaders(h);
    s = await a.setUp(1);
  }, 180_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const rows = await read.tenant(s.c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(MARKER);
    covered.add(action);
    return rows[0];
  }

  const dispatch = (id: string, verb: string, body?: object) =>
    a.http(
      'post',
      `/maintenance/tickets/${id}/${verb}`,
      s.supervisor.token,
      body,
    );
  const tech = (id: string, verb: string, body?: object) =>
    a.http('post', `/technician/tickets/${id}/${verb}`, s.techs[0].token, body);

  async function started(): Promise<string> {
    const id = await a.openTicket(s);
    await dispatch(id, 'assign', { technicianId: s.techs[0].id }).expect(204);
    await tech(id, 'start').expect(204);
    return id;
  }

  describe('dispatch’s own moves', () => {
    it('ticket.closed_by_staff — the code and the cycle', async () => {
      const id = await started();
      await tech(id, 'complete', {}).expect(204);
      await dispatch(id, 'close', { reasonCode: 'resident_left' }).expect(204);
      const row = await single('ticket.closed_by_staff', id);
      expect(row.actorId).toBe(s.supervisor.id);
      expect(row.metadata).toEqual({ reasonCode: 'resident_left', cycle: 1 });
    });

    it('ticket.reopened_by_staff — the origin, the code and the new cycle; never the words', async () => {
      const id = await started();
      await tech(id, 'complete', {}).expect(204);
      await dispatch(id, 'close', { reasonCode: 'other' }).expect(204);
      await dispatch(id, 'reopen', {
        reasonCode: 'not_fixed',
        reason: `${MARKER} it drips`,
      }).expect(204);
      expect((await single('ticket.reopened_by_staff', id)).metadata).toEqual({
        origin: 'resident',
        reasonCode: 'not_fixed',
        cycle: 2,
      });
    });

    it('ticket.resumed_by_staff — the origin, the hold reason and the cycle', async () => {
      const id = await started();
      await tech(id, 'hold', { holdReason: 'awaiting_parts' }).expect(204);
      await dispatch(id, 'resume').expect(204);
      expect((await single('ticket.resumed_by_staff', id)).metadata).toEqual({
        origin: 'resident',
        holdReason: 'awaiting_parts',
        cycle: 1,
      });
    });
  });

  describe('the SLA’s escalation levels', () => {
    it('maintenance.sla_escalation_changed — each priority changed, from and to', async () => {
      await a
        .http(
          'patch',
          '/maintenance/sla-settings/escalation',
          s.manager.token,
          {
            emergency: 60,
          },
        )
        .expect(200);
      expect(
        (await single('maintenance.sla_escalation_changed', s.c.tenantId))
          .changes,
      ).toEqual({ emergency: { from: 75, to: 60 } });
    });
  });

  describe('warranty claims', () => {
    async function claim(): Promise<{ id: string; assetId: string }> {
      const assetId = await a.asset(s);
      await a
        .http('patch', `/maintenance/assets/${assetId}`, s.manager.token, {
          warrantyEndsOn: addDays(today(), 30),
        })
        .expect(200);
      const res = await a
        .http('post', '/maintenance/warranty-claims', s.manager.token, {
          assetId,
          description: `${MARKER} the motor died`,
        })
        .expect(201);
      return { id: (res.body as { id: string }).id, assetId };
    }

    it('warranty_claim.opened — the asset and the ticket; never the words', async () => {
      const c = await claim();
      expect((await single('warranty_claim.opened', c.id)).metadata).toEqual({
        assetId: c.assetId,
        ticketId: null,
      });
    });

    it('warranty_claim.reference_set — the reference as changed', async () => {
      const c = await claim();
      await a
        .http(
          'patch',
          `/maintenance/warranty-claims/${c.id}`,
          s.manager.token,
          {
            reference: 'WR-55',
          },
        )
        .expect(200);
      const row = await single('warranty_claim.reference_set', c.id);
      expect(JSON.stringify(row)).not.toContain('WR-55');
    });

    it('warranty_claim.accepted — whether something was recovered', async () => {
      const c = await claim();
      await a
        .http(
          'post',
          `/maintenance/warranty-claims/${c.id}/accept`,
          s.manager.token,
          {
            recoveredAmount: '900',
          },
        )
        .expect(201);
      expect((await single('warranty_claim.accepted', c.id)).metadata).toEqual({
        recovered: true,
      });
    });

    it('warranty_claim.rejected and .withdrawn — the code', async () => {
      const one = await claim();
      await a
        .http(
          'post',
          `/maintenance/warranty-claims/${one.id}/reject`,
          s.manager.token,
          {
            reasonCode: 'not_covered',
          },
        )
        .expect(201);
      expect(
        (await single('warranty_claim.rejected', one.id)).metadata,
      ).toEqual({ reasonCode: 'not_covered' });
      const two = await claim();
      await a
        .http(
          'post',
          `/maintenance/warranty-claims/${two.id}/withdraw`,
          s.manager.token,
          {
            reasonCode: 'raised_in_error',
          },
        )
        .expect(201);
      expect(
        (await single('warranty_claim.withdrawn', two.id)).metadata,
      ).toEqual({ reasonCode: 'raised_in_error' });
    });
  });

  describe('catalog completeness', () => {
    it('every entry of dispatch depth has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of M22_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...M22_COVERAGE].sort());
    });
  });
});
