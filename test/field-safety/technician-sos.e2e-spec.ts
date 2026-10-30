import { err } from '../api/request';
import {
  fieldSafetyHelpers,
  type FieldSafetySetUp,
} from '../setup/field-safety';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Sos {
  id: string;
  type: string;
  status: string;
  location: { unitId: string } | null;
  post: unknown;
  ticket: { id: string; number: number } | null;
  familyNotified: number;
}

/**
 * ADR 0067: a technician's SOS from the ticket in their hands, with no
 * shift, through the staff's SOS core shared with the guard's (ADR 0053):
 * told and escalated as a guard's, nobody's family alerted, one open per
 * ticket — a repeat answers 200 with it. Who raised it only asks for it to
 * be called off: recorded and told, it stays open until a responder or the
 * management resolves it, since someone under duress can be made to cancel.
 */
describe('Field safety — a technician’s SOS', () => {
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

  const raise = (id: string, type = 'medical', i = 0) =>
    f.http('post', `/technician/tickets/${id}/sos`, f.tech(s, i).token, {
      type,
    });
  const cancelRequest = (id: string, i = 0, body: object = {}) =>
    f.http(
      'post',
      `/technician/tickets/${id}/sos/cancel-request`,
      f.tech(s, i).token,
      body,
    );

  it('raised from the ticket: its unit is where, no post, no family; the management has it', async () => {
    const id = await f.assigned(s, general);
    const res = await raise(id).expect(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const sos = res.body as Sos;
    const number = (
      await f.inTenant(s.c, (tx) =>
        tx.ticket.findUniqueOrThrow({ where: { id } }),
      )
    ).number;
    expect(sos).toMatchObject({
      type: 'medical',
      status: 'reported',
      location: { unitId: s.unit.id },
      post: null,
      ticket: { id, number },
      familyNotified: 0,
    });
    const row = await f.inTenant(s.c, (tx) =>
      tx.emergency.findUniqueOrThrow({ where: { id: sos.id } }),
    );
    expect(row).toMatchObject({
      originTicketId: id,
      unitId: null,
      originShiftId: null,
      reportedById: f.tech(s).id,
    });
    const managed = await f.inTenant(s.c, (tx) =>
      tx.notification.count({
        where: {
          accountId: s.manager.id,
          targetId: sos.id,
          kind: { in: ['emergency.reported', 'emergency.escalated'] },
        },
      }),
    );
    expect(managed).toBeGreaterThanOrEqual(1);
  });

  it('one open per ticket: a repeat, of any type, answers 200 with it; another ticket is another', async () => {
    const id = await f.assigned(s, general);
    const first = (await raise(id).expect(201)).body as Sos;
    expect(((await raise(id, 'fire').expect(200)).body as Sos).id).toBe(
      first.id,
    );
    const other = await f.assigned(s, general);
    expect(((await raise(other).expect(201)).body as Sos).id).not.toBe(
      first.id,
    );
  });

  it('from a ticket in the technician’s own hands only; asking to call it off leaves it open, told to the responders, once', async () => {
    const id = await f.assigned(s, general);
    expect(err(await raise(id, 'medical', 1).expect(404)).code).toBe(
      'TICKET_NOT_FOUND',
    );
    const sos = (await raise(id, 'security').expect(201)).body as Sos;
    expect(err(await cancelRequest(id, 1).expect(404)).code).toBe(
      'EMERGENCY_NOT_FOUND',
    );
    const asked = (
      await cancelRequest(id, 0, { reasonCode: 'false_alarm' }).expect(200)
    ).body as Sos & {
      cancelRequestedAt: string | null;
      cancelRequestReason: string | null;
    };
    // Someone under duress can be made to cancel: it stays open.
    expect(asked).toMatchObject({
      id: sos.id,
      status: 'reported',
      cancelRequestReason: 'false_alarm',
    });
    expect(asked.cancelRequestedAt).not.toBeNull();
    const told = () =>
      f.inTenant(s.c, (tx) =>
        tx.notification.count({
          where: { kind: 'emergency.cancel_requested', targetId: sos.id },
        }),
      );
    const first = await told();
    expect(first).toBeGreaterThanOrEqual(1);
    expect(
      await f.inTenant(s.c, (tx) =>
        tx.notification.count({
          where: { kind: 'emergency.cancelled', targetId: sos.id },
        }),
      ),
    ).toBe(0);
    // Asked again: the same request, told once.
    expect(
      (
        (await cancelRequest(id, 0, { reasonCode: 'other' }).expect(200))
          .body as typeof asked
      ).cancelRequestReason,
    ).toBe('false_alarm');
    expect(await told()).toBe(first);
    // Still open, a repeat SOS is the same one.
    expect(((await raise(id).expect(200)).body as Sos).id).toBe(sos.id);
  });

  it('a responder or the management closes it, and then it is over', async () => {
    const id = await f.assigned(s, general);
    const sos = (await raise(id).expect(201)).body as Sos;
    await cancelRequest(id).expect(200);
    // The technician who raised it closes nothing.
    await f
      .http('post', `/gate/emergencies/${sos.id}/resolve`, f.tech(s).token, {
        reasonCode: 'false_alarm',
      })
      .expect(403);
    expect(
      (
        await f
          .http(
            'post',
            `/gate/emergencies/${sos.id}/resolve`,
            s.manager.token,
            {
              reasonCode: 'false_alarm',
            },
          )
          .expect(200)
      ).body,
    ).toMatchObject({ id: sos.id, status: 'resolved' });
    expect(err(await cancelRequest(id).expect(404)).code).toBe(
      'EMERGENCY_NOT_FOUND',
    );
    // Over, the next is a new one.
    expect(((await raise(id).expect(201)).body as Sos).id).not.toBe(sos.id);
  });

  it('races: two SOS from one ticket at once leave one open', async () => {
    for (let round = 0; round < 3; round++) {
      const id = await f.assigned(s, general);
      const results = await Promise.all([raise(id), raise(id, 'fire')]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
      expect((results[0].body as Sos).id).toBe((results[1].body as Sos).id);
      expect(
        await f.inTenant(s.c, (tx) =>
          tx.emergency.count({
            where: {
              originTicketId: id,
              status: { in: ['reported', 'on_the_way', 'arrived'] },
            },
          }),
        ),
      ).toBe(1);
    }
  });
});
