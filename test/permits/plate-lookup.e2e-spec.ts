import { localParts } from '../../src/core/common/slots/day-slots';
import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { day, permitHelpers, ZONE } from '../setup/permits';

interface Match {
  kind: string;
  unitCode: string;
  plate: string;
  vehicle: unknown;
  pass: unknown;
  permit: {
    permitId: string;
    reference: string;
    permitKind: string;
    subjectType: string;
    subjectId: string;
    valid: boolean;
    refusal: string | null;
  } | null;
}

const hhmm = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

describe('Permits — the plate lookup finds moves and guests’ cars (ADR 0049)', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  it('an approved move’s truck and an event guest’s car: what to record against, whether they may come in; never a name; audited by ids', async () => {
    const c = await p.setUp('Plates Court');
    await p.anyTime(c.manager);
    const guard = await p.guardOnDuty(c.c);
    const now = localParts(new Date(), ZONE).minute;
    const window =
      now < 1380
        ? { from: hhmm(Math.max(0, now - 30)), to: hhmm(now + 60) }
        : { from: hhmm(now - 60), to: '23:59' };
    const move = await p.move(c.alice, c.home.id, {
      date: day(0),
      window,
      truckPlate: 'ن ق ل ٤٥٦',
    });
    const pendingMove = await p.move(c.alice, c.home.id, {
      date: day(0),
      window,
      truckPlate: 'نقل456',
    });
    await p.approve(c.manager, move.id);
    const event = await p.event(c.alice, c.home.id, 2, {
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      guests: [
        { fullName: 'Hidden Guest Name', vehiclePlate: 'gst 77' },
        { fullName: 'Removed Guest', vehiclePlate: 'GST 77' },
      ],
    });
    await p
      .http(
        'post',
        `/permits/${event.id}/guests/${event.event!.guests[1].id}/remove`,
        c.alice.token,
        {},
      )
      .expect(200);
    const lookup = (plate: string) =>
      p.http('post', '/gate/plate-lookup', guard.token, { plate }).expect(200);

    const truck = (await lookup('نقل ٤٥٦')).body as { matches: Match[] };
    expect(truck.matches).toEqual([
      {
        kind: 'unit_permit',
        unitCode: c.home.code,
        plate: 'ن ق ل ٤٥٦',
        vehicle: null,
        pass: null,
        permit: expect.objectContaining({
          permitId: move.id,
          reference: move.reference,
          permitKind: 'move',
          subjectType: 'move_permit',
          subjectId: move.id,
          valid: true,
          refusal: null,
        }) as object,
      },
    ]);
    expect(JSON.stringify(truck)).not.toContain(pendingMove.id);

    const car = (await lookup('GST77')).body as { matches: Match[] };
    expect(car.matches.map((m) => m.permit)).toEqual([
      expect.objectContaining({
        permitId: event.id,
        permitKind: 'event',
        subjectType: 'event_guest',
        subjectId: event.event!.guests[0].id,
        valid: true,
      }),
    ]);
    expect(JSON.stringify(car)).not.toContain('Hidden Guest Name');

    // Recorded against what the lookup named.
    await p
      .http('post', '/gate/entries', guard.token, {
        subjectType: 'move_permit',
        subjectId: move.id,
        direction: 'in',
      })
      .expect(201);

    const rows = await auditReaders(h).tenant(c.c.tenantId, {
      action: 'gate.plate_lookup',
      targetId: guard.shiftId,
    });
    expect(rows.map((r) => r.metadata)).toEqual([
      {
        vehicleIds: [],
        passIds: [],
        permitIds: [move.id],
        guestIds: [],
        matches: 1,
      },
      {
        vehicleIds: [],
        passIds: [],
        permitIds: [],
        guestIds: [event.event!.guests[0].id],
        matches: 1,
      },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/GST|٤٥٦|456/);
  });

  it('a revoked move is not found; one outside the hours says why', async () => {
    const c = await p.setUp('Plates Refused Court');
    await p.anyTime(c.manager);
    const guard = await p.guardOnDuty(c.c);
    const now = localParts(new Date(), ZONE).minute;
    const window =
      now < 1380
        ? { from: hhmm(Math.max(0, now - 30)), to: hhmm(now + 60) }
        : { from: hhmm(now - 60), to: '23:59' };
    const move = await p.move(c.alice, c.home.id, {
      date: day(0),
      window,
      truckPlate: 'REV 1',
    });
    await p.approve(c.manager, move.id);
    // The compound's hours narrowed to exclude now.
    await p.setRules(c.manager, {
      workHours:
        now >= 120
          ? { from: '00:00', to: hhmm(now - 60) }
          : { from: hhmm(now + 60), to: '23:59' },
    });
    const refused = (
      await p
        .http('post', '/gate/plate-lookup', guard.token, { plate: 'REV1' })
        .expect(200)
    ).body as { matches: Match[] };
    expect(refused.matches[0].permit).toMatchObject({
      valid: false,
      refusal: 'outside_work_hours',
    });
    await p
      .decide(c.manager, move.id, 'revoke', { reasonCode: 'other' })
      .expect(200);
    expect(
      (
        (
          await p
            .http('post', '/gate/plate-lookup', guard.token, { plate: 'REV1' })
            .expect(200)
        ).body as { matches: Match[] }
      ).matches,
    ).toEqual([]);
  });
});
