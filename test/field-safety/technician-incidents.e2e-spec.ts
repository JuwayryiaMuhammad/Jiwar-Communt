import { err } from '../api/request';
import {
  fieldSafetyHelpers,
  type FieldSafetySetUp,
} from '../setup/field-safety';
import { fileHelpers } from '../setup/files';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Incident {
  id: string;
  type: string;
  severity: string;
  unit: { unitId: string } | null;
  place: unknown;
  links: { ticketId: string | null };
  photos: unknown[];
}

/**
 * ADR 0067: a technician reports an injury, a near miss or a hazard from
 * the ticket in their hands, with no shift and a photo: where is the
 * ticket's — its unit, or the ticket itself for a common area's work —
 * and the incidents' keepers are told, as for a guard's report (ADR 0053).
 */
describe('Field safety — a technician’s incidents', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof fieldSafetyHelpers>;
  let s: FieldSafetySetUp;
  let general: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = fieldSafetyHelpers(h);
    s = await f.setUp(2);
    general = await f.category(s);
  }, 90_000);

  afterAll(() => h.close());

  const report = (id: string, body: object = {}, i = 0) =>
    f.http('post', `/technician/tickets/${id}/incidents`, f.tech(s, i).token, {
      type: 'injury',
      severity: 'high',
      occurredAt: new Date().toISOString(),
      description: 'Cut on the hand from a sharp edge',
      ...body,
    });

  it('from a ticket in a unit: the unit and the ticket, no place, no shift; a photo; the keepers told', async () => {
    const id = await f.assigned(s, general);
    const photo = await fileHelpers(h).ready(f.tech(s).token, 'incident_photo');
    const res = (await report(id, { photoFileIds: [photo] }).expect(201))
      .body as Incident;
    expect(res).toMatchObject({
      type: 'injury',
      severity: 'high',
      unit: { unitId: s.unit.id },
      place: null,
      links: { ticketId: id },
    });
    expect(res.photos).toHaveLength(1);
    // Who holds none of gate.operate, incidents.manage or tickets.work uploads none.
    expect(
      (
        await f
          .http('post', '/files/uploads', s.owner.token, {
            purpose: 'incident_photo',
            contentType: 'image/png',
            size: 100,
          })
          .expect(403)
      ).body,
    ).toMatchObject({ code: 'FORBIDDEN' });
    const row = await f.inTenant(s.c, (tx) =>
      tx.incident.findUniqueOrThrow({ where: { id: res.id } }),
    );
    expect(row).toMatchObject({
      ticketId: id,
      unitId: s.unit.id,
      placeId: null,
      shiftId: null,
      reportedById: f.tech(s).id,
    });
    const told = await f.inTenant(s.c, (tx) =>
      tx.notification.findMany({
        where: { kind: 'incident.reported', targetId: res.id },
      }),
    );
    expect(told.map((n) => n.accountId)).toContain(s.manager.id);
    const staff = (
      await f
        .http('get', `/staff/security/incidents/${res.id}`, s.manager.token)
        .expect(200)
    ).body as Incident;
    expect(staff.links.ticketId).toBe(id);
  });

  it('from a common area’s work order: the ticket is where', async () => {
    const pump = await f.asset(s);
    const id = await f.workOrder(s, pump, general);
    const res = (
      await report(id, { type: 'hazard', severity: 'medium' }).expect(201)
    ).body as Incident;
    expect(res).toMatchObject({
      unit: null,
      place: null,
      links: { ticketId: id },
    });
  });

  it('an injury, a near miss or a hazard, from a ticket in the technician’s own hands only', async () => {
    const id = await f.assigned(s, general);
    expect(err(await report(id, { type: 'fire' }).expect(400)).fields).toEqual([
      {
        field: 'type',
        code: 'INVALID_VALUE',
        params: { allowed: ['injury', 'near_miss', 'hazard'] },
      },
    ]);
    expect(err(await report(id, {}, 1).expect(404)).code).toBe(
      'TICKET_NOT_FOUND',
    );
    await f.step(s, id, 'start').expect(204);
    await f.step(s, id, 'complete').expect(204);
    expect(err(await report(id).expect(404)).code).toBe('TICKET_NOT_FOUND');
    // Without tickets.work, not at all.
    await f
      .http('post', `/technician/tickets/${id}/incidents`, s.manager.token, {})
      .expect(403);
  });
});
