import { AccountsService } from '../../src/core/accounts/accounts.service';
import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { HELP_ESCALATION_SWEEP } from '../../src/maintenance/help/help-requests.service';
import { ROSTER_ATTENDANCE_SWEEP } from '../../src/gate/roster/roster-attendance';
import { auditReaders } from '../setup/audit';
import { FIELD_TEAM_COVERAGE } from '../setup/audit-coverage-split';
import { eraseNow } from '../setup/erasure';
import { fieldTeamHelpers } from '../setup/field-team';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const MINUTE = 60_000;
const MARKER = 'AUDIT-m212-secret';

/**
 * One scenario per entry of the field team's catalog (ADR 0014, 0078):
 * actor, target and metadata — kinds, codes, ids and counts, never a
 * technician's words.
 */
const covered = new Set<string>();

describe('Audit coverage — the field team', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof fieldTeamHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: Awaited<ReturnType<ReturnType<typeof fieldTeamHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = fieldTeamHelpers(h);
    read = auditReaders(h);
    s = await x.setUp('Field Audit Court');
  }, 120_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const rows = await read.tenant(s.c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    expect(JSON.stringify(rows[0])).not.toContain(MARKER);
    return rows[0];
  }

  it('technician_shift.late and .absent — the minutes, the recipients; the system for an absence', async () => {
    const tech = await x.technician(s.c);
    const late = await x.dutySlot(s.c, tech.id, 30, 60);
    await x.onDuty(tech);
    expect(await single('technician_shift.late', late.id)).toMatchObject({
      actorId: tech.id,
      metadata: { minutes: expect.any(Number) as number },
    });
    await x.offDuty(tech);
    const away = await x.technician(s.c);
    const absent = await x.dutySlot(s.c, away.id, 61);
    await x.sweep(ROSTER_ATTENDANCE_SWEEP, new Date());
    expect(await single('technician_shift.absent', absent.id)).toMatchObject({
      actorType: 'system',
      metadata: { recipients: expect.any(Number) as number },
    });
  });

  it('technician_help.requested, .taken, .resolved, .cancelled, .escalated and .note_cleared — kinds, ids and counts, never the note', async () => {
    const tech = await x.technician(s.c);
    const helper = await x.technician(s.c);
    const call = (who: { token: string }, kind = 'safety') =>
      x
        .http('post', '/maintenance/help-requests', who.token, {
          kind,
          note: MARKER,
        })
        .expect(201)
        .then((r) => (r.body as { id: string }).id);

    const id = await call(tech);
    expect(await single('technician_help.requested', id)).toMatchObject({
      actorId: tech.id,
      metadata: { kind: 'safety' },
    });
    await x.sweep(HELP_ESCALATION_SWEEP, new Date(Date.now() + 16 * MINUTE));
    expect(await single('technician_help.escalated', id)).toMatchObject({
      actorType: 'system',
      metadata: { recipients: expect.any(Number) as number },
    });
    await x
      .http(
        'post',
        `/staff/field-team/help-requests/${id}/take`,
        s.boss.token,
        {
          helperId: helper.id,
        },
      )
      .expect(200);
    expect(await single('technician_help.taken', id)).toMatchObject({
      actorId: s.boss.id,
      metadata: { helperId: helper.id },
    });
    await x
      .http('post', `/maintenance/help-requests/${id}/resolve`, helper.token)
      .expect(200);
    expect(await single('technician_help.resolved', id)).toMatchObject({
      actorId: helper.id,
      metadata: { by: 'helper' },
    });

    const off = await call(tech, 'parts');
    await x
      .http('post', `/maintenance/help-requests/${off}/cancel`, tech.token)
      .expect(200);
    expect(await single('technician_help.cancelled', off)).toMatchObject({
      actorId: tech.id,
      metadata: { was: 'open' },
    });

    // Erased: their notes go, once each.
    await x.v.x.asManager(s.c, () =>
      h.moduleRef
        .get(AccountsService)
        .updateStatus(tech.id, { status: 'inactive' }),
    );
    await eraseNow(h, s.c, tech.id);
    // Done by whoever ran the erasure, on the account's behalf.
    expect(await single('technician_help.note_cleared', id)).toMatchObject({
      targetId: id,
    });
    covered.delete('technician_help.note_cleared');
    expect(await single('technician_help.note_cleared', off)).toBeDefined();
    const rows = await x.v.inTx(s.c, (tx) =>
      tx.technicianHelpRequest.findMany({ where: { requesterId: tech.id } }),
    );
    expect(rows.every((r) => r.note === null)).toBe(true);
  });

  describe('catalog completeness', () => {
    it('every entry of the field team has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of FIELD_TEAM_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...FIELD_TEAM_COVERAGE].sort());
    });
  });
});
