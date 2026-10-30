import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { FIELD_SAFETY_COVERAGE } from '../setup/audit-coverage-split';
import type { Compound } from '../setup/community';
import {
  fieldSafetyHelpers,
  hoursFromNow,
  type FieldSafetySetUp,
} from '../setup/field-safety';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * One scenario per entry of the field-safety catalog (ADR 0014, 0067):
 * actor, target, changes and metadata — hazards, ids, versions and codes;
 * the precautions as changed only; no instruction text.
 */
const covered = new Set<string>();

describe('Audit coverage — field safety', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof fieldSafetyHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: FieldSafetySetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = fieldSafetyHelpers(h);
    read = auditReaders(h);
    s = await f.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  async function single(c: Compound, action: string, targetId: string) {
    const rows = await read.tenant(c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    return rows[0];
  }

  it('ticket_category.permit_hazards_changed and asset_type.permit_hazards_changed — the list, from and to', async () => {
    const cat = await f.category(s, ['height']);
    expect(
      await single(s.c, 'ticket_category.permit_hazards_changed', cat),
    ).toMatchObject({
      actorId: s.manager.id,
      changes: { requiresPermit: { from: [], to: ['height'] } },
    });
    const typeId = await f.typeId(s, 'elevator');
    await f
      .http(
        'put',
        `/maintenance/asset-types/${typeId}/permit-hazards`,
        s.supervisor.token,
        {
          hazards: ['live_electrical'],
        },
      )
      .expect(200);
    expect(
      (await single(s.c, 'asset_type.permit_hazards_changed', typeId)).changes,
    ).toEqual({ requiresPermit: { from: [], to: ['live_electrical'] } });
  });

  it('work_permit.requested, .approved, .rejected and .revoked — the ticket, the hazard and the codes; the precautions as changed', async () => {
    const cat = await f.category(s, ['height']);
    const id = await f.assigned(s, cat);
    const expiresAt = hoursFromNow(3);
    const p = await f.permit(s, id, {
      precautions: 'AUDIT-secret harness',
      expiresAt: expiresAt.toISOString(),
    });
    expect(await single(s.c, 'work_permit.requested', p.id)).toMatchObject({
      actorId: f.tech(s).id,
      metadata: {
        ticketId: id,
        cycle: 1,
        hazard: 'height',
        expiresAt: expiresAt.toISOString(),
      },
      changes: { precautions: { changed: true } },
    });
    await f.decide(s, p.id, 'approve').expect(200);
    expect((await single(s.c, 'work_permit.approved', p.id)).metadata).toEqual({
      ticketId: id,
      hazard: 'height',
    });
    await f.decide(s, p.id, 'revoke', 'precautions_not_followed').expect(200);
    expect((await single(s.c, 'work_permit.revoked', p.id)).metadata).toEqual({
      ticketId: id,
      hazard: 'height',
      reasonCode: 'precautions_not_followed',
      ticketStatus: 'assigned',
    });
    const q = await f.permit(s, id, { hazard: 'hot_work' });
    await f.decide(s, q.id, 'reject', 'wrong_hazard').expect(200);
    expect((await single(s.c, 'work_permit.rejected', q.id)).metadata).toEqual({
      ticketId: id,
      hazard: 'hot_work',
      reasonCode: 'wrong_hazard',
    });
    const rows = await read.tenant(s.c.tenantId, { targetId: p.id });
    expect(JSON.stringify(rows)).not.toContain('AUDIT-secret');
  });

  it('safety_instruction.published and .acknowledged — the category, the version, the ticket and the hash; never the text', async () => {
    const cat = await f.category(s);
    const v = (
      await f
        .http(
          'post',
          `/maintenance/categories/${cat}/safety-instructions`,
          s.supervisor.token,
          {
            textEn: 'AUDIT-secret gloves',
            textAr: 'قفازات',
          },
        )
        .expect(201)
    ).body as { id: string };
    expect(
      (await single(s.c, 'safety_instruction.published', v.id)).metadata,
    ).toEqual({
      categoryId: cat,
      version: 1,
    });
    const id = await f.assigned(s, cat);
    const ack = (
      await f
        .http(
          'post',
          `/technician/tickets/${id}/safety/acknowledge`,
          f.tech(s).token,
          {
            instructionId: v.id,
          },
        )
        .expect(200)
    ).body as { contentSha256: string };
    expect(
      await single(s.c, 'safety_instruction.acknowledged', v.id),
    ).toMatchObject({
      actorId: f.tech(s).id,
      metadata: {
        ticketId: id,
        cycle: 1,
        version: 1,
        contentSha256: ack.contentSha256,
      },
    });
    const rows = await read.tenant(s.c.tenantId, { targetId: v.id });
    expect(JSON.stringify(rows)).not.toContain('AUDIT-secret');
  });

  it('emergency.cancel_requested — the status and the code; the SOS stays open', async () => {
    const id = await f.assigned(s, await f.category(s));
    const sos = (
      await f
        .http('post', `/technician/tickets/${id}/sos`, f.tech(s).token, {
          type: 'medical',
        })
        .expect(201)
    ).body as { id: string };
    await f
      .http(
        'post',
        `/technician/tickets/${id}/sos/cancel-request`,
        f.tech(s).token,
        { reasonCode: 'false_alarm' },
      )
      .expect(200);
    expect(
      await single(s.c, 'emergency.cancel_requested', sos.id),
    ).toMatchObject({
      actorId: f.tech(s).id,
      metadata: { status: 'reported', reasonCode: 'false_alarm' },
    });
  });

  describe('catalog completeness', () => {
    it('every field-safety entry has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of FIELD_SAFETY_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...FIELD_SAFETY_COVERAGE].sort());
    });
  });
});
