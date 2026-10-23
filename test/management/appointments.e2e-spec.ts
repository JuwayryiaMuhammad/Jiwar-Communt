import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  managementHelpers,
  type ManagementSetUp,
  type Who,
} from '../setup/management';
import { clock, clockAt } from '../setup/compound-clock';

const HOUR = 3_600_000;

/**
 * ADR 0039: appointments with the management. The resident picks a free
 * slot of the office hours; staff confirm it or propose another; the
 * resident accepts or picks again; either side cancels with a reason code.
 */
describe('Management appointments', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof managementHelpers>;
  let s: ManagementSetUp;
  let handler: Who;
  let topicId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = managementHelpers(h);
    s = await m.setUp();
    handler = await m.handler(s.c);
    topicId = await m.topicId(s.c);
  }, 120_000);

  afterAll(() => h.close());

  type Appointment = {
    id: string;
    status: string;
    mode: string;
    startsAt: string;
    endsAt: string;
    proposedBy: string;
    confirmedAt: string | null;
    cancelReason: string | null;
    cancelledBy: string | null;
  };
  const row = (id: string) =>
    m.x.asManager(s.c, () =>
      m.x.prisma.tenant.managementRequest.findUniqueOrThrow({ where: { id } }),
    );
  const appointmentOf = async (id: string, who: Who = s.owner) =>
    (
      (
        await m
          .http(
            'get',
            `${who === s.owner ? '/management-requests' : '/management/requests'}/${id}`,
            who.token,
          )
          .expect(200)
      ).body as { appointment: Appointment | null }
    ).appointment;
  const mine = (id: string, action: string, body?: object, who = s.owner) =>
    m.http(
      'post',
      `/management-requests/${id}/appointment${action}`,
      who.token,
      body,
    );
  const staff = (id: string, action: string, body?: object, who = handler) =>
    m.http(
      'post',
      `/management/requests/${id}/appointment/${action}`,
      who.token,
      body,
    );
  /** Slots nobody here has used yet. */
  let used = 0;
  const fresh = async (n = 1) => {
    const all = await m.slots(s.owner, 31);
    const out = all.slice(used, used + n).map((x) => x.startsAt);
    used += n;
    return out;
  };
  const booked = async (who: Who = s.owner) => {
    const [slot] = await fresh();
    const res = await m.book(s.c, who, slot, topicId).expect(201);
    return { id: (res.body as { id: string }).id, slot };
  };
  const wrongState = (res: { body: unknown }, status: string) =>
    expect(res.body).toMatchObject({
      code: 'MANAGEMENT_APPOINTMENT_INVALID_STATE',
      params: { status },
    });

  describe('slots', () => {
    it('are the office hours cut by the slot length, an hour to thirty days ahead', async () => {
      const res = await m
        .http('get', '/management-appointment-slots?days=31', s.owner.token)
        .expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const { data } = res.body as {
        data: { startsAt: string; endsAt: string }[];
      };
      expect(data.length).toBeGreaterThan(100);
      const now = Date.now();
      for (const slot of data) {
        const start = new Date(slot.startsAt);
        expect(new Date(slot.endsAt).getTime() - start.getTime()).toBe(
          30 * 60_000,
        );
        expect(start.getTime()).toBeGreaterThanOrEqual(now + HOUR - 60_000);
        // eslint-disable-next-line no-restricted-syntax -- a real 30 × 24 h: slots end MAX_AHEAD_MS from now
        expect(start.getTime()).toBeLessThanOrEqual(now + 30 * 24 * HOUR);
        // 09:00 to 17:00 in Cairo, never on a Friday.
        const local = clockAt(start);
        expect(local.weekday()).not.toBe(5);
        const minute = local.minute;
        expect(minute).toBeGreaterThanOrEqual(540);
        expect(minute).toBeLessThanOrEqual(990);
        expect(minute % 30).toBe(0);
      }
      // The author sees no count; staff see the places left.
      expect(Object.keys(data[0]).sort()).toEqual(['endsAt', 'startsAt']);
      const forStaff = await m
        .http('get', '/management/appointment-slots?days=1', handler.token)
        .expect(200);
      for (const slot of (forStaff.body as { data: { remaining: number }[] })
        .data)
        expect(slot.remaining).toBe(1);
    });

    it('follow the office hours and the slot length the manager sets', async () => {
      const other = await m.setUp();
      await m
        .http('patch', '/management/request-settings', other.manager.token, {
          appointmentSlotMinutes: 60,
        })
        .expect(200);
      const data = await m.slots(other.owner, 14);
      for (const slot of data)
        expect(
          new Date(slot.endsAt).getTime() - new Date(slot.startsAt).getTime(),
        ).toBe(HOUR);
      await m
        .http('put', '/management/office-hours', other.manager.token, {
          windows: [],
        })
        .expect(200);
      expect(await m.slots(other.owner, 31)).toEqual([]);
    });

    it('a day is a real day, and at most 31 are read at once', async () => {
      for (const [query, field] of [
        ['from=2031-02-30', 'from'],
        ['from=tomorrow', 'from'],
        ['days=32', 'days'],
      ]) {
        const res = await m
          .http('get', `/management-appointment-slots?${query}`, s.owner.token)
          .expect(400);
        expect(res.body).toMatchObject({ fields: [{ field }] });
      }
    });
  });

  describe('booking', () => {
    it('a resident opens an appointment request on a free slot: it waits for the management', async () => {
      const { id, slot } = await booked();
      expect(await appointmentOf(id)).toEqual({
        id: expect.any(String) as string,
        status: 'requested',
        mode: 'in_person',
        startsAt: slot,
        endsAt: new Date(new Date(slot).getTime() + 30 * 60_000).toISOString(),
        proposedBy: 'resident',
        confirmedAt: null,
        cancelReason: null,
        cancelledBy: null,
      });
      const request = await row(id);
      expect(request).toMatchObject({
        type: 'appointment',
        status: 'open',
        firstResponseAt: null,
      });
    });

    it('an appointment request needs its slot, and no other request takes one', async () => {
      const [slot] = await fresh();
      const none = await m
        .http('post', '/management-requests', s.owner.token, {
          type: 'appointment',
          topicId,
          body: 'No slot',
        })
        .expect(400);
      expect(none.body).toMatchObject({
        fields: [{ field: 'appointment', code: 'FIELD_REQUIRED' }],
      });
      const extra = await m
        .book(s.c, s.owner, slot, topicId, { type: 'question' })
        .expect(400);
      expect(extra.body).toMatchObject({
        fields: [{ field: 'appointment', code: 'FIELD_NOT_ALLOWED' }],
      });
      const mode = await m
        .book(s.c, s.owner, slot, topicId, {
          appointment: { startsAt: slot, mode: 'video' },
        })
        .expect(400);
      expect(mode.body).toMatchObject({
        fields: [
          {
            field: 'appointment.mode',
            code: 'INVALID_VALUE',
            params: { allowed: ['in_person', 'phone'] },
          },
        ],
      });
    });

    it('only the start of an offered slot: not between two, outside the hours, too soon or too far', async () => {
      const [slot] = await fresh();
      const start = new Date(slot).getTime();
      // Next Friday at 10:00 in Cairo is outside the hours whatever the season.
      const cairo = clock();
      const farMonday = cairo.day(
        [60, 61, 62, 63, 64, 65, 66].find(
          (k) => cairo.weekday(cairo.day(k)) === 1,
        )!,
      );
      const cases: [string, string][] = [
        [
          new Date(start + 60_000).toISOString(),
          'APPOINTMENT_SLOT_NOT_OFFERED',
        ],
        [new Date(start + 1).toISOString(), 'APPOINTMENT_SLOT_NOT_OFFERED'],
        // A Monday about two months on: 04:00 is outside the office hours
        // whatever the distance; 09:00 is in them, but too far ahead.
        [cairo.at(farMonday, 4).toISOString(), 'APPOINTMENT_SLOT_NOT_OFFERED'],
        [cairo.at(farMonday, 9).toISOString(), 'APPOINTMENT_TOO_FAR'],
        ['2021-01-11T07:00:00.000Z', 'APPOINTMENT_TOO_SOON'],
      ];
      const before = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.managementRequest.count(),
      );
      for (const [startsAt, code] of cases) {
        const res = await m.book(s.c, s.owner, startsAt, topicId).expect(400);
        expect(res.body).toMatchObject({
          code: 'VALIDATION_FAILED',
          fields: [{ field: 'appointment.startsAt', code }],
        });
      }
      // Nothing was opened by a refused booking.
      expect(
        await m.x.asManager(s.c, () =>
          m.x.prisma.tenant.managementRequest.count(),
        ),
      ).toBe(before);
    });

    it('a taken slot is full for the next resident, and gone from the list', async () => {
      const { slot } = await booked();
      const other = await m.who(
        s.c,
        (await m.x.resident(s.c, [(await m.x.unit(s.c)).id])).id,
        'resident',
      );
      const res = await m.book(s.c, other, slot, topicId).expect(409);
      expect(res.body).toMatchObject({
        code: 'MANAGEMENT_APPOINTMENT_SLOT_FULL',
      });
      expect((await m.slots(other, 31)).map((x) => x.startsAt)).not.toContain(
        slot,
      );
    });

    it('appointment actions are for appointment requests only', async () => {
      const { id } = await m.open(s.c, s.owner);
      const [slot] = await fresh();
      for (const res of [
        await mine(id, '', { startsAt: slot, mode: 'phone' }),
        await mine(id, '/accept'),
        await mine(id, '/cancel', { reasonCode: 'other' }),
        await staff(id, 'confirm'),
        await staff(id, 'propose', { startsAt: slot, mode: 'phone' }),
        await staff(id, 'cancel', { reasonCode: 'other' }),
      ]) {
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          code: 'MANAGEMENT_REQUEST_NOT_AN_APPOINTMENT',
        });
      }
    });
  });

  describe('confirming and proposing', () => {
    it('staff confirm the resident’s pick: agreed, and the request has its response', async () => {
      const { id } = await booked();
      await staff(id, 'confirm').expect(204);
      const appointment = (await appointmentOf(id))!;
      expect(appointment.status).toBe('confirmed');
      const request = await row(id);
      expect(request.status).toBe('in_progress');
      expect(request.firstResponseAt!.toISOString()).toBe(
        appointment.confirmedAt,
      );
      wrongState(await staff(id, 'confirm').expect(409), 'confirmed');
      // Nothing for the resident to accept: it was their own pick.
      wrongState(await mine(id, '/accept').expect(409), 'confirmed');
    });

    it('staff counter with another slot: the pick is superseded, the proposal waits for the resident, who accepts', async () => {
      const { id, slot } = await booked();
      const [other] = await fresh();
      const res = await staff(id, 'propose', {
        startsAt: other,
        mode: 'phone',
      }).expect(201);
      expect(res.body).toMatchObject({ status: 'proposed', startsAt: other });
      const proposed = (await appointmentOf(id, handler))!;
      expect(proposed).toMatchObject({
        status: 'proposed',
        mode: 'phone',
        startsAt: other,
        proposedBy: 'staff',
      });
      // A proposal is a response too.
      expect(await row(id)).toMatchObject({ status: 'in_progress' });
      expect((await row(id)).firstResponseAt).not.toBeNull();
      // The first slot is free again; the proposed one is held.
      const free = (await m.slots(s.owner, 31)).map((x) => x.startsAt);
      expect(free).toContain(slot);
      expect(free).not.toContain(other);
      // Staff cannot confirm their own proposal.
      wrongState(await staff(id, 'confirm').expect(409), 'proposed');
      await mine(id, '/accept').expect(204);
      expect(await appointmentOf(id)).toMatchObject({
        id: proposed.id,
        status: 'confirmed',
        startsAt: other,
      });
      const history = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.managementAppointment.findMany({
          where: { requestId: id },
          orderBy: { createdAt: 'asc' },
          select: { status: true, proposedBySide: true },
        }),
      );
      expect(history).toEqual([
        { status: 'superseded', proposedBySide: 'resident' },
        { status: 'confirmed', proposedBySide: 'staff' },
      ]);
    });

    it('the resident answers a proposal by picking again: it waits for the management once more', async () => {
      const { id } = await booked();
      const [theirs, again] = await fresh(2);
      await staff(id, 'propose', {
        startsAt: theirs,
        mode: 'in_person',
      }).expect(201);
      const res = await mine(id, '', { startsAt: again, mode: 'phone' }).expect(
        201,
      );
      expect(res.body).toMatchObject({ status: 'requested', startsAt: again });
      expect(await appointmentOf(id)).toMatchObject({
        status: 'requested',
        proposedBy: 'resident',
        mode: 'phone',
      });
      await staff(id, 'confirm').expect(204);
      expect((await appointmentOf(id))!.status).toBe('confirmed');
    });

    it('a confirmed appointment still moves: by the resident (waits again) or by staff (proposed)', async () => {
      const { id } = await booked();
      await staff(id, 'confirm').expect(204);
      const [a, b] = await fresh(2);
      await mine(id, '', { startsAt: a, mode: 'in_person' }).expect(201);
      expect((await appointmentOf(id))!.status).toBe('requested');
      await staff(id, 'confirm').expect(204);
      await staff(id, 'propose', { startsAt: b, mode: 'in_person' }).expect(
        201,
      );
      expect((await appointmentOf(id))!.status).toBe('proposed');
    });

    it('nothing is confirmed once its time has passed', async () => {
      const { id } = await booked();
      const past = new Date(Date.now() - 2 * HOUR);
      await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.managementAppointment.updateMany({
          where: { requestId: id, status: 'requested' },
          data: {
            startsAt: past,
            endsAt: new Date(past.getTime() + 30 * 60_000),
          },
        }),
      );
      const res = await staff(id, 'confirm').expect(409);
      expect(res.body).toMatchObject({
        code: 'MANAGEMENT_APPOINTMENT_WINDOW_PASSED',
      });
      expect((await appointmentOf(id))!.status).toBe('requested');
    });

    it('only staff confirm and propose; only the author picks, accepts and cancels on their side', async () => {
      const { id } = await booked();
      const [slot] = await fresh();
      await staff(id, 'confirm', undefined, s.owner).expect(403);
      await staff(
        id,
        'propose',
        { startsAt: slot, mode: 'phone' },
        s.owner,
      ).expect(403);
      await mine(id, '', { startsAt: slot, mode: 'phone' }, handler).expect(
        403,
      );
      const stranger = await m.setUp();
      for (const res of [
        await mine(id, '', { startsAt: slot, mode: 'phone' }, stranger.owner),
        await mine(id, '/accept', undefined, stranger.owner),
        await mine(id, '/cancel', { reasonCode: 'other' }, stranger.owner),
        await staff(id, 'confirm', undefined, stranger.manager),
      ])
        expect(res.status).toBe(404);
      expect((await appointmentOf(id))!.status).toBe('requested');
    });
  });

  describe('cancelling', () => {
    it('the resident cancels with one of their reasons; the slot is free again', async () => {
      const { id, slot } = await booked();
      const bad = await mine(id, '/cancel', {
        reasonCode: 'office_closed',
      }).expect(400);
      expect(bad.body).toMatchObject({
        fields: [
          {
            field: 'reasonCode',
            code: 'INVALID_REASON_CODE',
            params: {
              allowed: ['no_longer_needed', 'cannot_attend', 'other'],
            },
          },
        ],
      });
      await mine(id, '/cancel', { reasonCode: 'cannot_attend' }).expect(204);
      expect(await appointmentOf(id)).toMatchObject({
        status: 'cancelled',
        cancelReason: 'cannot_attend',
        cancelledBy: 'resident',
      });
      expect((await m.slots(s.owner, 31)).map((x) => x.startsAt)).toContain(
        slot,
      );
      wrongState(
        await mine(id, '/cancel', { reasonCode: 'other' }).expect(409),
        'none',
      );
      // The request itself goes on: the resident may pick again.
      expect((await row(id)).status).toBe('open');
      await mine(id, '', { startsAt: slot, mode: 'in_person' }).expect(201);
    });

    it('staff cancel with one of theirs', async () => {
      const { id } = await booked();
      await staff(id, 'confirm').expect(204);
      const bad = await staff(id, 'cancel', {
        reasonCode: 'cannot_attend',
      }).expect(400);
      expect(bad.body).toMatchObject({
        fields: [
          {
            field: 'reasonCode',
            params: {
              allowed: ['staff_unavailable', 'office_closed', 'other'],
            },
          },
        ],
      });
      await staff(id, 'cancel', { reasonCode: 'office_closed' }).expect(204);
      expect(await appointmentOf(id)).toMatchObject({
        status: 'cancelled',
        cancelReason: 'office_closed',
        cancelledBy: 'staff',
      });
      // And may propose a new time afterwards.
      const [slot] = await fresh();
      await staff(id, 'propose', { startsAt: slot, mode: 'phone' }).expect(201);
    });

    it.each([
      ['closed by staff', 'staff'],
      ['withdrawn by the author', 'resident'],
    ] as const)(
      'a request %s takes its appointment with it, and frees the slot',
      async (_how, side) => {
        const { id, slot } = await booked();
        if (side === 'staff')
          await m
            .http('post', `/management/requests/${id}/close`, handler.token, {
              reasonCode: 'resolved',
            })
            .expect(204);
        else
          await m
            .http('post', `/management-requests/${id}/withdraw`, s.owner.token)
            .expect(204);
        expect(await appointmentOf(id)).toMatchObject({
          status: 'cancelled',
          cancelReason: 'request_closed',
          cancelledBy: 'system',
        });
        expect((await m.slots(s.owner, 31)).map((x) => x.startsAt)).toContain(
          slot,
        );
        // No appointment action on a closed request.
        const res = await mine(id, '', {
          startsAt: slot,
          mode: 'phone',
        }).expect(409);
        expect(res.body).toMatchObject({
          code: 'MANAGEMENT_REQUEST_INVALID_TRANSITION',
          params: { status: 'closed' },
        });
      },
    );
  });

  describe('on behalf, and the agenda', () => {
    it('staff book a slot for a resident who came in: confirmed at once, and counted as their response', async () => {
      const [slot] = await fresh();
      const res = await m
        .http('post', '/management/requests', s.manager.token, {
          type: 'appointment',
          topicId,
          authorAccountId: s.owner.id,
          reasonCode: 'resident_walk_in',
          body: 'Wants to discuss the service charge',
          appointment: { startsAt: slot, mode: 'in_person' },
        })
        .expect(201);
      const { id } = res.body as { id: string };
      expect(res.body).toMatchObject({ status: 'in_progress' });
      expect(await appointmentOf(id)).toMatchObject({
        status: 'confirmed',
        proposedBy: 'staff',
        startsAt: slot,
      });
      expect((await row(id)).firstResponseAt).not.toBeNull();
    });

    it('the agenda lists appointments soonest first, with their request and its author, filtered by status and day', async () => {
      const list = async (query = '') =>
        (
          (
            await m
              .http(
                'get',
                `/management/appointments?limit=100${query}`,
                handler.token,
              )
              .expect(200)
          ).body as {
            data: (Appointment & {
              request: { id: string; number: string; author: { id: string } };
            })[];
          }
        ).data;
      const all = await list();
      expect(all.length).toBeGreaterThan(5);
      const starts = all.map((a) => new Date(a.startsAt).getTime());
      expect(starts).toEqual([...starts].sort((p, q) => p - q));
      expect(all[0].request).toMatchObject({
        number: expect.stringMatching(/^MR-\d{6}$/) as string,
        author: { id: s.owner.id },
      });
      // Holding a slot: decided by the API, so every page of an agenda is full.
      const live = await list('&live=true');
      expect(live.length).toBeGreaterThan(0);
      expect(
        live.every((a) =>
          ['requested', 'proposed', 'confirmed'].includes(a.status),
        ),
      ).toBe(true);
      expect(live.length).toBe(
        all.filter((a) =>
          ['requested', 'proposed', 'confirmed'].includes(a.status),
        ).length,
      );
      const confirmed = await list('&status=confirmed');
      expect(confirmed.length).toBeGreaterThan(0);
      expect(new Set(confirmed.map((a) => a.status))).toEqual(
        new Set(['confirmed']),
      );
      const pivot = confirmed[0].startsAt;
      const from = await list(`&from=${encodeURIComponent(pivot)}`);
      expect(from.every((a) => a.startsAt >= pivot)).toBe(true);
      const until = await list(`&to=${encodeURIComponent(pivot)}`);
      expect(until.every((a) => a.startsAt < pivot)).toBe(true);
      expect(from.length + until.length).toBe(all.length);
      await m
        .http('get', '/management/appointments', s.owner.token)
        .expect(403);
    });
  });
});
