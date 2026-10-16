import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { at, day, permitHelpers, type PermitBody } from '../setup/permits';

describe('Permits — private events and their guests (ADR 0049)', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  const fields = (res: { body: unknown }) =>
    (res.body as { fields?: unknown }).fields;

  it('up to 20 guests: approved at once, may hold 20, nobody told', async () => {
    const c = await p.setUp('Events Small Court');
    const event = await p.event(c.alice, c.home.id, 20);
    expect(event).toMatchObject({
      reference: expect.stringMatching(/^E-\d{4,}$/) as string,
      kind: 'event',
      status: 'approved',
      decisionSource: 'auto',
      decidedAt: expect.any(String) as string,
      event: { title: 'Birthday', guestLimit: 20, guestCount: 20 },
    });
    expect(new Date(event.startsAt)).toEqual(at(day(2), 18));
    expect(event.event!.guests[0]).toMatchObject({
      fullName: 'Guest Number 1',
      vehiclePlate: null,
      removedAt: null,
    });
    expect(await p.told(c.c, c.manager.id, event.id)).toEqual([]);
  });

  it('21 to 150: pending, for the management, may hold as many as listed; more than 150 is refused', async () => {
    const c = await p.setUp('Events Large Court');
    const event = await p.event(c.alice, c.home.id, 21);
    expect(event).toMatchObject({
      status: 'pending',
      decisionSource: null,
      event: { guestLimit: 21, guestCount: 21 },
    });
    expect(await p.told(c.c, c.manager.id, event.id)).toEqual([
      { kind: 'unit_permit.requested', params: { permitKind: 'event' } },
    ]);
    expect(
      (
        await p
          .http('post', `/permits/${event.id}/guests`, c.alice.token, {
            guests: p.guestList(1),
          })
          .expect(409)
      ).body,
    ).toMatchObject({
      code: 'PERMIT_LIMIT_REACHED',
      params: { scope: 'guests', max: 21 },
    });
    expect(
      fields(await p.eventRaw(c.alice, c.home.id, 151).expect(400)),
    ).toEqual([
      {
        field: 'guests',
        code: 'INVALID_LENGTH',
        params: { min: 1, max: 150 },
      },
    ]);
    await p.event(c.alice, c.home.id, 150);
  });

  it('anyone the unit lets invite visitors holds one; the primary sees and manages it too', async () => {
    const c = await p.setUp('Events Who Court');
    // A landlord, who does not live there, may not invite visitors.
    const rented = await p.unit(c.c, 'E2');
    const landlord = await p.landlord(c.c, rented.id);
    expect(
      (await p.eventRaw(landlord, rented.id).expect(403)).body,
    ).toMatchObject({ code: 'PERMIT_NOT_ALLOWED' });
    // A member invites with the visitors grant (granted by default).
    const member = await p.family(c.c, c.home.id, c.alice);
    const event = await p.event(member, c.home.id);
    expect(event).toMatchObject({ mine: true });
    expect((await p.get(c.alice, event.id)).mine).toBe(false);
    // The member's list holds their own only; the primary's, everything.
    const list = async (token: string) =>
      (
        (
          await p
            .http('get', `/units/${c.home.id}/permits?kind=event`, token)
            .expect(200)
        ).body as { data: PermitBody[] }
      ).data.map((x) => x.id);
    expect(await list(member.token)).toEqual([event.id]);
    expect(await list(c.alice.token)).toEqual([event.id]);
    await p
      .http('post', `/permits/${event.id}/cancel`, c.alice.token, {})
      .expect(200);
  });

  it('the window: not long past, within 90 days, after its start, 24 hours at most', async () => {
    const c = await p.setUp('Events Window Court');
    const bad = async (over: Record<string, unknown>) =>
      fields(await p.eventRaw(c.alice, c.home.id, 3, over).expect(400));
    expect(
      await bad({
        startsAt: at(day(-1), 18).toISOString(),
        endsAt: at(day(-1), 20).toISOString(),
      }),
    ).toEqual([{ field: 'startsAt', code: 'INVALID_VALUE' }]);
    expect(
      await bad({
        startsAt: at(day(91), 18).toISOString(),
        endsAt: at(day(91), 20).toISOString(),
      }),
    ).toEqual([
      {
        field: 'startsAt',
        code: 'DAY_OUT_OF_RANGE',
        params: { min: day(0), max: day(90) },
      },
    ]);
    expect(
      await bad({
        startsAt: at(day(2), 20).toISOString(),
        endsAt: at(day(2), 18).toISOString(),
      }),
    ).toEqual([{ field: 'endsAt', code: 'ENDS_BEFORE_START' }]);
    expect(
      await bad({
        startsAt: at(day(2), 18).toISOString(),
        endsAt: at(day(3), 19).toISOString(),
      }),
    ).toEqual([
      { field: 'endsAt', code: 'WINDOW_TOO_LONG', params: { maxHours: 24 } },
    ]);
    // Past midnight is fine.
    await p.event(c.alice, c.home.id, 3, {
      startsAt: at(day(2), 20).toISOString(),
      endsAt: at(day(3), 2).toISOString(),
    });
    expect(
      await bad({
        guests: [{ fullName: 'Plate Person', vehiclePlate: '???' }],
      }),
    ).toEqual([
      {
        field: 'guests.0.vehiclePlate',
        code: 'INVALID_FORMAT',
        params: { maxLength: 12 },
      },
    ]);
  });

  it('three upcoming events per unit', async () => {
    const c = await p.setUp('Events Limit Court');
    for (let i = 0; i < 3; i += 1) await p.event(c.alice, c.home.id);
    expect(
      (await p.eventRaw(c.alice, c.home.id).expect(409)).body,
    ).toMatchObject({
      code: 'PERMIT_LIMIT_REACHED',
      params: { scope: 'event', max: 3 },
    });
  });

  it('guests are added until the limit and the start, taken off while open; plates tidied', async () => {
    const c = await p.setUp('Events Guests Court');
    const event = await p.event(c.alice, c.home.id, 18);
    const added = (
      await p
        .http('post', `/permits/${event.id}/guests`, c.alice.token, {
          guests: [
            { fullName: 'Late Guest', vehiclePlate: ' gst  ٩ ' },
            { fullName: 'Later Guest' },
          ],
        })
        .expect(201)
    ).body as PermitBody;
    expect(added.event).toMatchObject({ guestCount: 20 });
    expect(added.event!.guests.at(-2)).toMatchObject({
      fullName: 'Late Guest',
      vehiclePlate: 'GST ٩',
    });
    expect(
      (
        await p
          .http('post', `/permits/${event.id}/guests`, c.alice.token, {
            guests: p.guestList(1),
          })
          .expect(409)
      ).body,
    ).toMatchObject({
      code: 'PERMIT_LIMIT_REACHED',
      params: { scope: 'guests', max: 20 },
    });
    const first = added.event!.guests[0];
    const removed = (
      await p
        .http(
          'post',
          `/permits/${event.id}/guests/${first.id}/remove`,
          c.alice.token,
          {},
        )
        .expect(200)
    ).body as PermitBody;
    expect(removed.event).toMatchObject({ guestCount: 19 });
    expect(removed.event!.guests[0].removedAt).not.toBeNull();
    await p
      .http('post', `/permits/${event.id}/guests`, c.alice.token, {
        guests: p.guestList(1),
      })
      .expect(201);
    // Once started, the list is fixed.
    const started = await p.event(c.alice, c.home.id, 2, {
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(
      (
        await p
          .http('post', `/permits/${started.id}/guests`, c.alice.token, {
            guests: p.guestList(1),
          })
          .expect(409)
      ).body,
    ).toMatchObject({ code: 'PERMIT_STARTED' });
    // Another event's guest is not found by this one.
    expect(
      (
        await p
          .http(
            'post',
            `/permits/${started.id}/guests/${first.id}/remove`,
            c.alice.token,
            {},
          )
          .expect(404)
      ).body,
    ).toMatchObject({ code: 'PERMIT_GUEST_NOT_FOUND' });
    // A works permit has no guests.
    const works = await p.works(c.alice, c.home.id);
    expect(
      (
        await p
          .http('post', `/permits/${works.id}/guests`, c.alice.token, {
            guests: p.guestList(1),
          })
          .expect(404)
      ).body,
    ).toMatchObject({ code: 'PERMIT_NOT_FOUND' });
    // Nor an event workers.
    expect(
      p.status(await p.addWorkerRaw(c.alice, event.id), 404).body,
    ).toMatchObject({ code: 'PERMIT_NOT_FOUND' });
  });
});
