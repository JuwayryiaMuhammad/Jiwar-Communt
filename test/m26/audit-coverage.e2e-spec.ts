import { AUDIT_ACTIONS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { M26_COVERAGE } from '../setup/audit-coverage-split';
import { complianceHelpers } from '../setup/compliance';
import { dbClock, day } from '../setup/compound-clock';
import { eraseNow } from '../setup/erasure';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const MARKER = 'AUDIT-m26-secret';

/**
 * One scenario per entry of ADR 0087's catalog: actor, target and metadata
 * — ids, kinds, days, months and codes; the notes, a description and a done
 * note as changed only or booleans, never their words.
 */
const covered = new Set<string>();

describe('Audit coverage — compliance and corrective actions (ADR 0087)', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof complianceHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: Awaited<ReturnType<ReturnType<typeof complianceHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = complianceHelpers(h);
    read = auditReaders(h);
    s = await x.setUp();
  }, 180_000);

  afterAll(() => h.close());

  const m = () => s.manager.token;
  async function single(action: string, targetId: string) {
    const rows = await read.tenant(s.c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    expect(JSON.stringify(rows[0])).not.toContain(MARKER);
    return rows[0];
  }

  it('compliance_item.created, .updated, .completed, .evidence_added, .evidence_removed, .retired', async () => {
    const item = await x.create(m(), {
      kind: 'lift',
      title: 'Lift licence',
      ownerId: s.tech.id,
      recurrenceMonths: 12,
      notes: MARKER,
      firstDueOn: day(30),
    });
    expect(await single('compliance_item.created', item.id)).toMatchObject({
      actorId: s.manager.id,
      changes: {
        kind: { from: null, to: 'lift' },
        notes: { changed: true },
        recurrenceMonths: { from: null, to: 12 },
        dueOn: { from: null, to: day(30) },
      },
    });
    await x
      .http('patch', `/staff/compliance/items/${item.id}`, m(), {
        notes: `${MARKER} again`,
        nextDueOn: day(40),
      })
      .expect(200);
    expect(await single('compliance_item.updated', item.id)).toMatchObject({
      changes: {
        notes: { changed: true },
        dueOn: { from: day(30), to: day(40) },
      },
    });
    const done = (
      await x
        .completeRaw(m(), item.current!.id, {
          doneOn: day(0),
          note: MARKER,
          certificateNumber: 'C-1',
        })
        .expect(200)
    ).body as { current: { id: string } };
    expect(await single('compliance_item.completed', item.id)).toMatchObject({
      metadata: {
        occurrenceId: item.current!.id,
        dueOn: day(40),
        doneOn: day(0),
        nextOccurrenceId: done.current.id,
        files: 0,
        note: true,
        certificateNumber: true,
      },
    });
    const file = await x.files.ready(m(), 'compliance_evidence');
    const added = (
      await x
        .http(
          'post',
          `/staff/compliance/occurrences/${item.current!.id}/evidence`,
          m(),
          { fileId: file },
        )
        .expect(201)
    ).body as { evidence: { id: string }[] };
    expect(
      await single('compliance_item.evidence_added', item.id),
    ).toMatchObject({
      metadata: {
        occurrenceId: item.current!.id,
        evidenceId: added.evidence[0].id,
      },
    });
    await x
      .http('delete', `/staff/compliance/evidence/${added.evidence[0].id}`, m())
      .expect(204);
    expect(
      await single('compliance_item.evidence_removed', item.id),
    ).toMatchObject({ metadata: { evidenceId: added.evidence[0].id } });
    await x
      .http('post', `/staff/compliance/items/${item.id}/retire`, m(), {
        reasonCode: 'replaced',
      })
      .expect(200);
    expect(await single('compliance_item.retired', item.id)).toMatchObject({
      metadata: { reasonCode: 'replaced', occurrenceId: done.current.id },
    });
  });

  it('compliance.settings_changed — the lead times, from and to', async () => {
    await x
      .http('put', '/staff/compliance/settings', m(), { leadDays: [45, 10] })
      .expect(200);
    expect(
      await single('compliance.settings_changed', s.c.tenantId),
    ).toMatchObject({
      changes: { leadDays: { from: '60,30,7', to: '45,10' } },
    });
  });

  it('incident_action.created, .updated, .done, .cancelled, .text_cleared', async () => {
    const keeper = await x.staff(s.c, ['incidents.manage']);
    const incident = (
      await x
        .http('post', '/staff/security/incidents', m(), {
          type: 'hazard',
          severity: 'low',
          unitCode: s.home.code,
          occurredAt: new Date(dbClock().getTime() - 60_000).toISOString(),
          description: 'Wet floor',
        })
        .expect(201)
    ).body as { id: string };
    const add = async (token: string) =>
      (
        (
          await x
            .http(
              'post',
              `/staff/security/incidents/${incident.id}/actions`,
              token,
              { description: MARKER, ownerId: s.tech.id, dueOn: day(5) },
            )
            .expect(201)
        ).body as { id: string }
      ).id;
    const a = await add(keeper.token);
    expect(await single('incident_action.created', a)).toMatchObject({
      actorId: keeper.id,
      metadata: { incidentId: incident.id },
      changes: { description: { changed: true } },
    });
    await x
      .http('patch', `/staff/security/incident-actions/${a}`, m(), {
        dueOn: day(6),
      })
      .expect(200);
    expect(await single('incident_action.updated', a)).toMatchObject({
      changes: { dueOn: { from: day(5), to: day(6) } },
    });
    await x
      .http('post', `/staff/incident-actions/${a}/done`, s.tech.token, {
        note: MARKER,
      })
      .expect(200);
    expect(await single('incident_action.done', a)).toMatchObject({
      actorId: s.tech.id,
      metadata: { incidentId: incident.id, by: 'owner', note: true },
    });
    const b = await add(m());
    await x
      .http('post', `/staff/security/incident-actions/${b}/cancel`, m(), {
        reasonCode: 'duplicate',
      })
      .expect(200);
    expect(await single('incident_action.cancelled', b)).toMatchObject({
      metadata: { incidentId: incident.id, reasonCode: 'duplicate' },
    });
    await x
      .http('patch', `/accounts/${keeper.id}/status`, m(), {
        status: 'inactive',
      })
      .expect(200);
    await eraseNow(h, s.c, keeper.id);
    expect(await single('incident_action.text_cleared', a)).toMatchObject({
      metadata: { incidentId: incident.id, description: true, doneNote: false },
    });
  });

  it('covers every entry of its list, and the list names only catalog actions', () => {
    for (const k of M26_COVERAGE)
      expect(Object.keys(AUDIT_ACTIONS)).toContain(k);
    expect([...covered].sort()).toEqual([...M26_COVERAGE].sort());
  });
});
