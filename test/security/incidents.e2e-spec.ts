import { newId } from '../../src/core/common/uuid';
import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { leakText } from '../setup/leak-text';
import { securityOpsHelpers, type Who } from '../setup/security-ops';

interface IncidentBody {
  id: string;
  reference: string;
  type: string;
  severity: string;
  status: string;
  place: { id: string } | null;
  unit: { unitId: string; unitCode: string } | null;
  description: string | null;
  photos: { url: string }[];
  links: { emergencyId: string | null };
  outcome: string | null;
  closedAt: string | null;
  authorAcknowledgedAt: string | null;
  reviewerAcknowledgedAt: string | null;
  investigator?: { id: string } | null;
  notes?: { body: string | null; author: { id: string } }[];
  closingNote?: string | null;
  post?: { gateId: string | null } | null;
}

// eslint-disable-next-line no-restricted-syntax -- a real 24 h: the report's look-back is now − 30 × 24 h, in ms
const DAY = 86_400_000;

/**
 * ADR 0053: a guard on shift, or the management, reports an incident; the
 * keepers are told (a critical one critically); the management assigns an
 * investigator, writes internal notes and closes it with an outcome and a
 * note; the author and a reviewer each acknowledge it once. A guard reads
 * only their own, never the internal notes or the closing note; residents
 * never see incidents.
 */
describe('Incidents', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let guard: Who & { gateId: string; shiftId: string };
  let supervisor: Who;
  let placeId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Incidents Court');
    guard = await x.guardOnDuty(s.c);
    supervisor = await x.supervisor(s.c);
    placeId = (await x.places(s.alice)).clubhouse.id;
  }, 120_000);

  afterAll(() => h.close());

  const reportRaw = (as: Who, body: Record<string, unknown> = {}) =>
    x.http('post', '/gate/incidents', as.token, {
      type: 'hazard',
      severity: 'medium',
      placeId,
      occurredAt: new Date(Date.now() - 600_000).toISOString(),
      description: 'A loose cable by the pool',
      ...body,
    });
  const report = async (as: Who, body: Record<string, unknown> = {}) => {
    const res = await reportRaw(as, body);
    if (res.status !== 201)
      throw new Error(`report: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as IncidentBody;
  };
  const staff = (
    method: 'get' | 'post',
    path: string,
    as = s.manager,
    body?: object,
  ) => x.http(method, `/staff/security/incidents${path}`, as.token, body);

  it('a guard reports: where, when, their words, photos, a link; the keepers told; audited by ids and codes', async () => {
    const emergency = await x.report(s.alice, s.home.id, 'medical');
    const photos = [
      await x.photo(guard, 'incident_photo'),
      await x.photo(guard, 'incident_photo'),
    ];
    const res = await reportRaw(guard, {
      unitCode: s.home.code,
      photoFileIds: photos,
      emergencyId: emergency.id,
    }).expect(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const i = res.body as IncidentBody;
    expect(i).toMatchObject({
      type: 'hazard',
      severity: 'medium',
      status: 'open',
      place: { id: placeId },
      unit: { unitId: s.home.id, unitCode: s.home.code },
      description: 'A loose cable by the pool',
      links: { emergencyId: emergency.id },
      outcome: null,
      authorAcknowledgedAt: null,
    });
    expect(i.reference).toMatch(/^I-\d{4}$/);
    expect(i.photos).toHaveLength(2);
    // The guard's view has nothing of the management's.
    for (const key of ['investigator', 'notes', 'closingNote', 'reportedBy'])
      expect(i).not.toHaveProperty(key);
    for (const who of [s.manager, supervisor])
      expect(await x.told(s.c, who.id, i.id)).toEqual([
        {
          kind: 'incident.reported',
          params: { severity: 'medium', incidentType: 'hazard' },
        },
      ]);
    expect(await x.told(s.c, guard.id, i.id)).toEqual([]);
    const [row] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'incident.reported',
      targetId: i.id,
    });
    expect(row).toMatchObject({ actorId: guard.id, targetType: 'incident' });
    expect(row.metadata).toEqual({
      number: expect.any(Number) as number,
      type: 'hazard',
      severity: 'medium',
      placeId,
      unitId: s.home.id,
      shiftId: guard.shiftId,
      photos: 2,
      emergencyId: emergency.id,
      gateServiceRequestId: null,
      patrolNoteId: null,
    });
    expect(leakText(row)).not.toContain('loose cable');
    // The management sees where the guard was.
    const full = (await staff('get', `/${i.id}`).expect(200))
      .body as IncidentBody;
    expect(full.post).toMatchObject({ gateId: guard.gateId });
  });

  it('a critical incident is a critical push to the keepers', async () => {
    const i = await report(guard, { type: 'fire', severity: 'critical' });
    expect(await x.told(s.c, s.manager.id, i.id)).toEqual([
      { kind: 'incident.critical', params: { incidentType: 'fire' } },
    ]);
  });

  it('refuses what is not a report: nowhere, too long ago, a link or a place that is none, six photos, off shift, a resident', async () => {
    const fields = async (body: Record<string, unknown>) =>
      (
        (await reportRaw(guard, body).expect(400)).body as {
          fields: { field: string; code: string }[];
        }
      ).fields.map((f) => [f.field, f.code]);
    expect(await fields({ placeId: undefined })).toEqual([
      ['placeId', 'FIELD_REQUIRED'],
      ['unitCode', 'FIELD_REQUIRED'],
    ]);
    expect(
      await fields({
        occurredAt: new Date(Date.now() - 31 * DAY).toISOString(),
      }),
    ).toEqual([['occurredAt', 'INVALID_VALUE']]);
    expect(
      await fields({ photoFileIds: Array.from({ length: 6 }, () => newId()) }),
    ).toEqual([['photoFileIds', 'INVALID_LENGTH']]);
    await reportRaw(guard, { patrolNoteId: newId() })
      .expect(404)
      .expect((r) =>
        expect(r.body).toMatchObject({
          code: 'INCIDENT_LINK_NOT_FOUND',
          params: { field: 'patrolNoteId' },
        }),
      );
    await reportRaw(guard, { placeId: newId() })
      .expect(404)
      .expect((r) => expect(r.body).toMatchObject({ code: 'PLACE_NOT_FOUND' }));
    await reportRaw(guard, { placeId: undefined, unitCode: 'NO-SUCH-UNIT' })
      .expect(404)
      .expect((r) => expect(r.body).toMatchObject({ code: 'UNIT_NOT_FOUND' }));
    const offShift = await x.guard(s.c);
    await reportRaw(offShift)
      .expect(403)
      .expect((r) => expect(r.body).toMatchObject({ code: 'NO_OPEN_SHIFT' }));
    await reportRaw(s.alice).expect(403);
    await x.http('get', '/gate/incidents', s.alice.token).expect(403);
    await staff('get', '', s.alice).expect(403);
    await staff('get', '', guard).expect(403);
  });

  it('a guard reads only what they reported', async () => {
    const mine = await report(guard);
    const other = await x.guardOnDuty(s.c);
    const theirs = await report(other);
    const list = (
      (await x.http('get', '/gate/incidents', guard.token).expect(200))
        .body as {
        data: IncidentBody[];
      }
    ).data.map((i) => i.id);
    expect(list).toContain(mine.id);
    expect(list).not.toContain(theirs.id);
    await x
      .http('get', `/gate/incidents/${theirs.id}`, guard.token)
      .expect(404)
      .expect((r) =>
        expect(r.body).toMatchObject({ code: 'INCIDENT_NOT_FOUND' }),
      );
  });

  it('investigated: an eligible investigator, told; internal notes the guard never reads; closed once with an outcome and a note of the management’s', async () => {
    const i = await report(guard);
    await staff('post', `/${i.id}/assign`, s.manager, {
      investigatorId: guard.id,
    })
      .expect(422)
      .expect((r) =>
        expect(r.body).toMatchObject({ code: 'INVESTIGATOR_NOT_ELIGIBLE' }),
      );
    const assigned = (
      await staff('post', `/${i.id}/assign`, s.manager, {
        investigatorId: supervisor.id,
      }).expect(200)
    ).body as IncidentBody;
    expect(assigned).toMatchObject({
      status: 'investigating',
      investigator: { id: supervisor.id },
    });
    expect(await x.told(s.c, supervisor.id, i.id)).toEqual(
      expect.arrayContaining([{ kind: 'incident.assigned', params: {} }]),
    );
    await staff('post', `/${i.id}/notes`, supervisor, {
      body: 'Internal: the contractor left it',
    }).expect(200);
    const closed = (
      await staff('post', `/${i.id}/close`, supervisor, {
        reasonCode: 'resolved',
        note: 'Closing words of the management',
      }).expect(200)
    ).body as IncidentBody;
    expect(closed).toMatchObject({
      status: 'closed',
      outcome: 'resolved',
      closingNote: 'Closing words of the management',
      notes: [
        {
          body: 'Internal: the contractor left it',
          author: { id: supervisor.id },
        },
      ],
    });
    const seen = await x
      .http('get', `/gate/incidents/${i.id}`, guard.token)
      .expect(200);
    expect(seen.body).toMatchObject({ status: 'closed', outcome: 'resolved' });
    expect(leakText(seen.body)).not.toMatch(
      /Internal: the contractor|Closing words|investigator/,
    );
    for (const [path, body] of [
      ['close', { reasonCode: 'other', note: 'Again' }],
      ['assign', { investigatorId: s.manager.id }],
    ] as const)
      await staff('post', `/${i.id}/${path}`, s.manager, body)
        .expect(409)
        .expect((r) =>
          expect(r.body).toMatchObject({ code: 'INCIDENT_CLOSED' }),
        );
    await staff('post', `/${i.id}/close`, s.manager, {
      reasonCode: 'oops',
      note: 'x',
    }).expect(400);
    const rows = await auditReaders(h).tenant(s.c.tenantId, { targetId: i.id });
    expect(rows.map((r) => [r.action, r.metadata])).toEqual(
      expect.arrayContaining([
        ['incident.assigned', { investigatorId: supervisor.id, from: null }],
        ['incident.note_added', { noteId: expect.any(String) as string }],
        ['incident.closed', { outcome: 'resolved', from: 'investigating' }],
      ]),
    );
    expect(leakText(rows)).not.toMatch(/Internal|Closing words/);
  });

  it('acknowledged once by its author and once by a reviewer; never the author as reviewer', async () => {
    const i = await report(guard);
    for (let n = 0; n < 2; n++)
      await x
        .http('post', `/gate/incidents/${i.id}/acknowledge`, guard.token, {})
        .expect(200)
        .expect((r) =>
          expect(r.body).toMatchObject({
            authorAcknowledgedAt: expect.any(String) as string,
          }),
        );
    const other = await x.guardOnDuty(s.c);
    await x
      .http('post', `/gate/incidents/${i.id}/acknowledge`, other.token, {})
      .expect(404);
    await staff('post', `/${i.id}/acknowledge`, s.manager, {
      role: 'author',
    }).expect(403);
    await staff('post', `/${i.id}/acknowledge`, s.manager, {
      role: 'reviewer',
    }).expect(200);
    const twice = (
      await staff('post', `/${i.id}/acknowledge`, supervisor, {
        role: 'reviewer',
      }).expect(200)
    ).body as IncidentBody & {
      acknowledgements: { role: string; account: { id: string } }[];
    };
    expect(
      twice.acknowledgements.map((a) => [a.role, a.account.id]).sort(),
    ).toEqual([
      ['author', guard.id],
      ['reviewer', s.manager.id],
    ]);
    const acks = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'incident.acknowledged',
      targetId: i.id,
    });
    expect(acks.map((a) => a.metadata)).toEqual([
      { role: 'author' },
      { role: 'reviewer' },
    ]);
    // The management's own report: never reviewed by its author.
    const office = (
      await staff('post', '', s.manager, {
        type: 'near_miss',
        severity: 'low',
        unitCode: s.home.code,
        occurredAt: new Date().toISOString(),
        description: 'Reported at the office',
      }).expect(201)
    ).body as IncidentBody;
    expect(office.post).toBeNull();
    await staff('post', `/${office.id}/acknowledge`, s.manager, {
      role: 'reviewer',
    })
      .expect(403)
      .expect((r) => expect(r.body).toMatchObject({ code: 'INCIDENT_OWN' }));
    await staff('post', `/${office.id}/acknowledge`, s.manager, {
      role: 'author',
    }).expect(200);
  });
  it('who may investigate: the active keepers by name; never asked by a guard', async () => {
    const res = await x
      .http('get', '/staff/security/incidents/investigators', s.manager.token)
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const ids = (
      res.body as { data: { id: string; fullName: string | null }[] }
    ).data.map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining([s.manager.id, supervisor.id]));
    expect(ids).not.toContain(guard.id);
    await x
      .http('get', '/staff/security/incidents/investigators', guard.token)
      .expect(403);
  });
});
