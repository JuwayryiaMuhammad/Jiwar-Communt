import type { Response } from 'supertest';
import { newId } from '../../src/core/common/uuid';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { ParcelTokens } from '../../src/gate/parcels/parcel-tokens';
import { hashPassword } from '../../src/core/platform/password';
import { fileHelpers } from '../setup/files';
import { parcelHelpers } from '../setup/parcels';
import { bornYearsAgo, uniqueSuffix } from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { buildExports } from '../setup/exports';
import { waitForMessage, waitForOtp } from '../setup/mailpit';
import { drainOutbox } from '../setup/outbox';
import { call } from './request';
import { ROUTES } from './routes';
import { inviteBody, minorBody } from './routes/household';
import { ticketBody } from './routes/maintenance';
import { passBody } from './routes/visitors';
import { workerBody } from './routes/workers';
import { buildWorld, type World } from './world';

/**
 * Every response that carries a secret shown once (ADR 0025) is
 * `Cache-Control: no-store`: each registry row marked `noStore` is called
 * for real, successfully, here.
 */
describe('API v0 — no-store', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  const body = <T>(res: Response) => res.body as T;

  /**
   * An assisted export of A's tenant (ADR 0036), built, and the link its
   * email carries (once per suite).
   */
  let assisted: Promise<{ token: string; email: string }> | null = null;
  const assistedLink = () =>
    (assisted ??= (async () => {
      const email = (
        await w.helpers.asManager(w.a, () =>
          w.helpers.prisma.tenant.account.findUniqueOrThrow({
            where: { id: w.a.ids.tenant },
          }),
        )
      ).email!;
      const since = new Date();
      await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.dataExport.create({
          data: {
            id: newId(),
            tenantId: w.a.tenantId,
            accountId: w.a.ids.tenant,
            requestedByAccountId: w.a.ids.manager,
            assisted: true,
            assistReasonCode: 'in_person',
            delivery: 'email',
          },
        }),
      );
      await buildExports(h);
      await drainOutbox(h);
      const message = await waitForMessage(email, since);
      const token = /\/a\/export#([0-9a-f-]{36}\.[0-9a-f]{64})/.exec(
        message.Text,
      )![1];
      return { token, email };
    })());

  /** A ticket the owner opened on their home. */
  async function aTicket(): Promise<string> {
    const res = await call(w, 'POST', '/tickets', {
      token: w.a.tokens.owner,
      body: ticketBody(w.a.homeUnitId, w.aCategoryId),
    }).expect(201);
    return body<{ id: string }>(res).id;
  }

  // Requests to the management (ADR 0039).
  const topic = async (key = 'general') =>
    (
      await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.managementRequestTopic.findFirstOrThrow({
          where: { key },
        }),
      )
    ).id;
  /** A request A's owner opened; its id. */
  async function aRequest(): Promise<string> {
    const res = await call(w, 'POST', '/management-requests', {
      token: w.a.tokens.owner,
      body: { type: 'question', topicId: await topic(), body: 'No-store' },
    }).expect(201);
    return body<{ id: string }>(res).id;
  }
  /** A request staff closed. */
  async function aClosedRequest(): Promise<string> {
    const id = await aRequest();
    await call(w, 'POST', `/management/requests/${id}/close`, {
      token: w.a.tokens.manager,
      body: { reasonCode: 'resolved' },
    }).expect(204);
    return id;
  }
  /** Free slots, far enough ahead to still be bookable a moment later. */
  let slotsTaken = 0;
  async function aSlot(): Promise<string> {
    const res = await call(w, 'GET', '/management-appointment-slots', {
      token: w.a.tokens.owner,
      query: { days: '31' },
    }).expect(200);
    const soon = Date.now() + 2 * 3_600_000;
    const free = body<{ data: { startsAt: string }[] }>(res).data.filter(
      (slot) => new Date(slot.startsAt).getTime() > soon,
    );
    return free[slotsTaken++].startsAt;
  }
  /** An appointment request of A's owner, waiting for the management. */
  async function anAppointment(): Promise<string> {
    const res = await call(w, 'POST', '/management-requests', {
      token: w.a.tokens.owner,
      body: {
        type: 'appointment',
        topicId: await topic(),
        body: 'No-store',
        appointment: { startsAt: await aSlot(), mode: 'in_person' },
      },
    }).expect(201);
    return body<{ id: string }>(res).id;
  }

  /** A parcel the guard received for A's home. */
  async function aParcel(): Promise<string> {
    const unit = await w.helpers.unitRow(w.a, w.a.homeUnitId);
    const res = await parcelHelpers(h).receive(w.a.tokens.guard, unit.code);
    return body<{ id: string }>(res).id;
  }

  /** A ticket of A's home, assigned, with a visit soon; `confirmed` agrees to it. */
  async function aVisit(
    confirmed = false,
  ): Promise<{ ticketId: string; visitId: string }> {
    const ticketId = await aTicket();
    await call(w, 'POST', `/maintenance/tickets/${ticketId}/assign`, {
      token: w.a.tokens.manager,
      body: { technicianId: w.a.ids.technician },
    }).expect(204);
    const start = Date.now() + 20 * 60_000;
    const visit = await call(
      w,
      'POST',
      `/technician/tickets/${ticketId}/visits`,
      {
        token: w.a.tokens.technician,
        body: {
          startsAt: new Date(start).toISOString(),
          endsAt: new Date(start + 3_600_000).toISOString(),
        },
      },
    ).expect(201);
    const visitId = body<{ id: string }>(visit).id;
    if (confirmed)
      await call(w, 'POST', `/tickets/${ticketId}/visits/${visitId}/confirm`, {
        token: w.a.tokens.owner,
      }).expect(204);
    return { ticketId, visitId };
  }

  async function login(): Promise<{
    verify: Response;
    select: Response;
    refresh: Response;
  }> {
    const person = await w.helpers.resident(w.a, [w.a.homeUnitId], 'tenant');
    const since = new Date();
    await call(w, 'POST', '/auth/otp/request', {
      body: { identifier: person.email },
    }).expect(202);
    const code = await waitForOtp(person.email, since);
    const verify = await call(w, 'POST', '/auth/otp/verify', {
      body: { identifier: person.email, code },
    });
    const select = await call(w, 'POST', '/auth/select-account', {
      body: {
        loginTicket: body<{ loginTicket: string }>(verify).loginTicket,
        accountId: person.id,
      },
    });
    const refresh = await call(w, 'POST', '/auth/refresh', {
      body: {
        refreshToken: body<{ refreshToken: string }>(select).refreshToken,
      },
    });
    return { verify, select, refresh };
  }

  async function platform(mustChangePassword: boolean) {
    const email = `admin-${uniqueSuffix()}@jiwar.test`;
    await h.moduleRef.get(GlobalDbService).platformAdmin.create({
      data: {
        id: newId(),
        email,
        passwordHash: await hashPassword('no-store-password-1'),
        mustChangePassword,
      },
    });
    return call(w, 'POST', '/platform/auth/login', {
      body: { email, password: 'no-store-password-1' },
    });
  }

  async function activeEngagement() {
    const reg = await call(w, 'POST', `/units/${w.a.homeUnitId}/workers`, {
      token: w.a.tokens.owner,
      body: workerBody(),
    }).expect(201);
    const id = body<{ engagementId: string }>(reg).engagementId;
    const review = await call(w, 'POST', `/worker-engagements/${id}/review`, {
      token: w.a.tokens.manager,
      body: { decision: 'approve' },
    });
    return { id, review };
  }

  /** A live visitor link's token (ADR 0030): the fragment of `link`. */
  async function linkToken(): Promise<string> {
    const pass = await call(
      w,
      'POST',
      `/units/${w.a.homeUnitId}/visitor-passes`,
      { token: w.a.tokens.owner, body: passBody() },
    ).expect(201);
    return body<{ link: string }>(pass).link.split('#')[1];
  }

  // Community life (ADR 0040).
  const day = (n: number) => new Date(Date.now() + n * 86_400_000);
  const created = async (path: string, token: string, payload: object) =>
    body<{ id: string }>(
      await call(w, 'POST', path, { token, body: payload }).expect(201),
    ).id;
  /** A draft announcement of A's manager. */
  const aDraft = () =>
    created('/community/announcements', w.a.tokens.manager, {
      kind: 'general',
      titleEn: 'No-store',
      bodyEn: 'No-store',
    });
  /** An announcement that is out, put to everyone. */
  async function anAnnouncement(): Promise<string> {
    const id = await aDraft();
    await call(w, 'POST', `/community/announcements/${id}/publish`, {
      token: w.a.tokens.manager,
    }).expect(204);
    return id;
  }
  const anEvent = () =>
    created('/community/events', w.a.tokens.manager, {
      titleEn: 'No-store',
      descriptionEn: 'No-store',
      place: 'No-store',
      startsAt: day(2),
      endsAt: day(3),
    });
  const aPoll = () =>
    created('/community/polls', w.a.tokens.manager, {
      questionEn: 'No-store?',
      options: [{ labelEn: 'Yes' }, { labelEn: 'No' }],
      closesAt: day(3),
    });
  const suggestionTopic = async () =>
    (
      await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.suggestionTopic.findFirstOrThrow({
          where: { key: 'general' },
        }),
      )
    ).id;
  /** A suggestion of A's owner. */
  const aSuggestion = async () =>
    created('/suggestions', w.a.tokens.owner, {
      topicId: await suggestionTopic(),
      body: 'No-store',
    });
  /** One the staff put on the board. */
  async function aPublishedSuggestion(): Promise<string> {
    const id = await aSuggestion();
    await call(w, 'POST', `/community/suggestions/${id}/publish`, {
      token: w.a.tokens.manager,
      body: { titleEn: 'No-store', textEn: 'No-store' },
    }).expect(204);
    return id;
  }
  /** One that was done. */
  async function aDoneSuggestion(): Promise<string> {
    const id = await aSuggestion();
    await call(w, 'POST', `/community/suggestions/${id}/status`, {
      token: w.a.tokens.manager,
      body: { status: 'done' },
    }).expect(204);
    return id;
  }
  const asManager = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    path: string,
    payload?: object,
  ) => call(w, method, path, { token: w.a.tokens.manager, body: payload });
  const asOwner = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    payload?: object,
  ) => call(w, method, path, { token: w.a.tokens.owner, body: payload });

  const CALLS: Record<string, () => Promise<Response>> = {
    // Community life (ADR 0040): every response is no-store.
    'GET /community/settings': () => asManager('GET', '/community/settings'),
    'PATCH /community/settings': () =>
      asManager('PATCH', '/community/settings', { eventMaxGuests: 3 }),
    'GET /community/suggestion-topics': () =>
      asManager('GET', '/community/suggestion-topics'),
    'POST /community/suggestion-topics': () =>
      asManager('POST', '/community/suggestion-topics', {
        key: `nostore_${uniqueSuffix().toLowerCase()}`.slice(0, 40),
        nameAr: 'بلا تخزين',
        nameEn: 'No-store',
      }),
    'PATCH /community/suggestion-topics/{id}': async () =>
      asManager(
        'PATCH',
        `/community/suggestion-topics/${await suggestionTopic()}`,
        { nameEn: 'General' },
      ),
    'GET /suggestion-topics': () => asOwner('GET', '/suggestion-topics'),
    'GET /community/buildings': () => asManager('GET', '/community/buildings'),
    'POST /community/audience/preview': () =>
      asManager('POST', '/community/audience/preview', {
        audience: { occupancy: 'owners' },
      }),
    'GET /community/announcements': async () => {
      await aDraft();
      return asManager('GET', '/community/announcements');
    },
    'POST /community/announcements': () =>
      asManager('POST', '/community/announcements', {
        kind: 'general',
        titleEn: 'No-store',
        bodyEn: 'No-store',
      }),
    'GET /community/announcements/{id}': async () =>
      asManager('GET', `/community/announcements/${await aDraft()}`),
    'PATCH /community/announcements/{id}': async () =>
      asManager('PATCH', `/community/announcements/${await aDraft()}`, {
        bodyEn: 'No-store, again',
      }),
    'POST /community/announcements/{id}/publish': async () =>
      asManager('POST', `/community/announcements/${await aDraft()}/publish`),
    'POST /community/announcements/{id}/archive': async () =>
      asManager(
        'POST',
        `/community/announcements/${await anAnnouncement()}/archive`,
      ),
    'GET /community/announcements/{id}/versions': async () =>
      asManager('GET', `/community/announcements/${await aDraft()}/versions`),
    'GET /community/announcements/{id}/reads': async () =>
      asManager(
        'GET',
        `/community/announcements/${await anAnnouncement()}/reads`,
      ),
    'GET /announcements': async () => {
      await anAnnouncement();
      return asOwner('GET', '/announcements');
    },
    'GET /announcements/{id}': async () =>
      asOwner('GET', `/announcements/${await anAnnouncement()}`),
    'POST /announcements/{id}/read': async () =>
      asOwner('POST', `/announcements/${await anAnnouncement()}/read`),
    'GET /community/events': async () => {
      await anEvent();
      return asManager('GET', '/community/events');
    },
    'POST /community/events': () =>
      asManager('POST', '/community/events', {
        titleEn: 'No-store',
        descriptionEn: 'No-store',
        place: 'No-store',
        startsAt: day(2),
        endsAt: day(3),
      }),
    'GET /community/events/{id}': async () =>
      asManager('GET', `/community/events/${await anEvent()}`),
    'PATCH /community/events/{id}': async () =>
      asManager('PATCH', `/community/events/${await anEvent()}`, {
        capacity: 50,
      }),
    'POST /community/events/{id}/cancel': async () =>
      asManager('POST', `/community/events/${await anEvent()}/cancel`, {
        reasonCode: 'weather',
      }),
    'GET /community/events/{id}/attendees': async () =>
      asManager('GET', `/community/events/${await anEvent()}/attendees`),
    'GET /events': async () => {
      await anEvent();
      return asOwner('GET', '/events');
    },
    'GET /events/{id}': async () =>
      asOwner('GET', `/events/${await anEvent()}`),
    'PUT /events/{id}/rsvp': async () =>
      asOwner('PUT', `/events/${await anEvent()}/rsvp`, {
        response: 'going',
        guests: 1,
      }),
    'GET /community/polls': async () => {
      await aPoll();
      return asManager('GET', '/community/polls');
    },
    'POST /community/polls': () =>
      asManager('POST', '/community/polls', {
        questionEn: 'No-store?',
        options: [{ labelEn: 'Yes' }, { labelEn: 'No' }],
        closesAt: day(3),
      }),
    'GET /community/polls/{id}': async () =>
      asManager('GET', `/community/polls/${await aPoll()}`),
    'GET /community/polls/{id}/audience': async () =>
      asManager('GET', `/community/polls/${await aPoll()}/audience`),
    'PATCH /community/polls/{id}': async () =>
      asManager('PATCH', `/community/polls/${await aPoll()}`, {
        closesAt: day(5),
      }),
    'POST /community/polls/{id}/close': async () =>
      asManager('POST', `/community/polls/${await aPoll()}/close`),
    'POST /community/polls/{id}/cancel': async () =>
      asManager('POST', `/community/polls/${await aPoll()}/cancel`),
    'GET /polls': async () => {
      await aPoll();
      return asOwner('GET', '/polls');
    },
    'GET /polls/{id}': async () => asOwner('GET', `/polls/${await aPoll()}`),
    'POST /polls/{id}/votes': async () => {
      const id = await aPoll();
      const poll = body<{ options: { id: string }[] }>(
        await asOwner('GET', `/polls/${id}`).expect(200),
      );
      return asOwner('POST', `/polls/${id}/votes`, {
        optionIds: [poll.options[0].id],
      });
    },
    'GET /suggestions': async () => {
      await aSuggestion();
      return asOwner('GET', '/suggestions');
    },
    'POST /suggestions': async () =>
      asOwner('POST', '/suggestions', {
        topicId: await suggestionTopic(),
        body: 'No-store',
      }),
    'GET /suggestions/{id}': async () =>
      asOwner('GET', `/suggestions/${await aSuggestion()}`),
    'GET /suggestion-board': async () => {
      await aPublishedSuggestion();
      return asOwner('GET', '/suggestion-board');
    },
    'GET /suggestion-board/done': () =>
      asOwner('GET', '/suggestion-board/done'),
    'PUT /suggestion-board/{id}/support': async () =>
      asOwner(
        'PUT',
        `/suggestion-board/${await aPublishedSuggestion()}/support`,
      ),
    'DELETE /suggestion-board/{id}/support': async () =>
      asOwner(
        'DELETE',
        `/suggestion-board/${await aPublishedSuggestion()}/support`,
      ),
    'GET /community/suggestions': async () => {
      await aSuggestion();
      return asManager('GET', '/community/suggestions');
    },
    'GET /community/suggestions/{id}': async () =>
      asManager('GET', `/community/suggestions/${await aSuggestion()}`),
    'POST /community/suggestions/{id}/status': async () =>
      asManager(
        'POST',
        `/community/suggestions/${await aSuggestion()}/status`,
        {
          status: 'under_review',
        },
      ),
    'PUT /community/suggestions/{id}/response': async () =>
      asManager(
        'PUT',
        `/community/suggestions/${await aSuggestion()}/response`,
        {
          response: 'No-store',
        },
      ),
    'POST /community/suggestions/{id}/publish': async () =>
      asManager(
        'POST',
        `/community/suggestions/${await aSuggestion()}/publish`,
        {
          titleEn: 'No-store',
          textEn: 'No-store',
        },
      ),
    'POST /community/suggestions/{id}/unpublish': async () =>
      asManager(
        'POST',
        `/community/suggestions/${await aPublishedSuggestion()}/unpublish`,
      ),
    'PUT /community/suggestions/{id}/done-note': async () =>
      asManager(
        'PUT',
        `/community/suggestions/${await aDoneSuggestion()}/done-note`,
        { noteEn: 'No-store' },
      ),
    'GET /me/daily-brief': () => asOwner('GET', '/me/daily-brief'),
    // Requests to the management (ADR 0039): every response is no-store.
    'POST /management-requests': async () =>
      call(w, 'POST', '/management-requests', {
        token: w.a.tokens.owner,
        body: { type: 'general', topicId: await topic(), body: 'No-store' },
      }),
    'GET /management-requests': async () => {
      await aRequest();
      return call(w, 'GET', '/management-requests', {
        token: w.a.tokens.owner,
      });
    },
    'GET /management-requests/{id}': async () =>
      call(w, 'GET', `/management-requests/${await aRequest()}`, {
        token: w.a.tokens.owner,
      }),
    'GET /management-requests/{id}/messages': async () =>
      call(w, 'GET', `/management-requests/${await aRequest()}/messages`, {
        token: w.a.tokens.owner,
      }),
    'POST /management-requests/{id}/messages': async () =>
      call(w, 'POST', `/management-requests/${await aRequest()}/messages`, {
        token: w.a.tokens.owner,
        body: { body: 'More' },
      }),
    'POST /management-requests/{id}/withdraw': async () =>
      call(w, 'POST', `/management-requests/${await aRequest()}/withdraw`, {
        token: w.a.tokens.owner,
      }),
    'POST /management-requests/{id}/reopen': async () =>
      call(w, 'POST', `/management-requests/${await aClosedRequest()}/reopen`, {
        token: w.a.tokens.owner,
        body: { body: 'Again' },
      }),
    'POST /management-requests/{id}/rating': async () =>
      call(w, 'POST', `/management-requests/${await aClosedRequest()}/rating`, {
        token: w.a.tokens.owner,
        body: { rating: 5 },
      }),
    'GET /management-appointment-slots': () =>
      call(w, 'GET', '/management-appointment-slots', {
        token: w.a.tokens.owner,
      }),
    'POST /management-requests/{id}/appointment': async () => {
      const id = await anAppointment();
      return call(w, 'POST', `/management-requests/${id}/appointment`, {
        token: w.a.tokens.owner,
        body: { startsAt: await aSlot(), mode: 'phone' },
      });
    },
    'POST /management-requests/{id}/appointment/accept': async () => {
      const id = await anAppointment();
      await call(w, 'POST', `/management/requests/${id}/appointment/propose`, {
        token: w.a.tokens.manager,
        body: { startsAt: await aSlot(), mode: 'phone' },
      }).expect(201);
      return call(w, 'POST', `/management-requests/${id}/appointment/accept`, {
        token: w.a.tokens.owner,
      });
    },
    'POST /management-requests/{id}/appointment/cancel': async () =>
      call(
        w,
        'POST',
        `/management-requests/${await anAppointment()}/appointment/cancel`,
        { token: w.a.tokens.owner, body: { reasonCode: 'cannot_attend' } },
      ),
    'GET /me/requests': async () => {
      await aRequest();
      return call(w, 'GET', '/me/requests', { token: w.a.tokens.owner });
    },
    'GET /management/requests': async () => {
      await aRequest();
      return call(w, 'GET', '/management/requests', {
        token: w.a.tokens.manager,
      });
    },
    'POST /management/requests': async () =>
      call(w, 'POST', '/management/requests', {
        token: w.a.tokens.manager,
        body: {
          type: 'general',
          topicId: await topic(),
          authorAccountId: w.a.ids.owner,
          reasonCode: 'resident_walk_in',
          body: 'No-store',
        },
      }),
    'GET /management/requests/{id}': async () =>
      call(w, 'GET', `/management/requests/${await aRequest()}`, {
        token: w.a.tokens.manager,
      }),
    'POST /management/requests/{id}/assign': async () =>
      call(w, 'POST', `/management/requests/${await aRequest()}/assign`, {
        token: w.a.tokens.manager,
        body: { assigneeId: w.a.ids.manager },
      }),
    'GET /management/requests/{id}/messages': async () =>
      call(w, 'GET', `/management/requests/${await aRequest()}/messages`, {
        token: w.a.tokens.manager,
      }),
    'POST /management/requests/{id}/messages': async () =>
      call(w, 'POST', `/management/requests/${await aRequest()}/messages`, {
        token: w.a.tokens.manager,
        body: { body: 'The answer', official: true },
      }),
    'POST /management/requests/{id}/start': async () =>
      call(w, 'POST', `/management/requests/${await aRequest()}/start`, {
        token: w.a.tokens.manager,
      }),
    'POST /management/requests/{id}/close': async () =>
      call(w, 'POST', `/management/requests/${await aRequest()}/close`, {
        token: w.a.tokens.manager,
        body: { reasonCode: 'duplicate' },
      }),
    'GET /management/request-assignees': () =>
      call(w, 'GET', '/management/request-assignees', {
        token: w.a.tokens.manager,
      }),
    'GET /management/units/{unitId}/request-authors': () =>
      call(w, 'GET', `/management/units/${w.a.homeUnitId}/request-authors`, {
        token: w.a.tokens.manager,
      }),
    'GET /management/appointments': async () => {
      await anAppointment();
      return call(w, 'GET', '/management/appointments', {
        token: w.a.tokens.manager,
      });
    },
    'GET /management/appointment-slots': () =>
      call(w, 'GET', '/management/appointment-slots', {
        token: w.a.tokens.manager,
      }),
    'POST /management/requests/{id}/appointment/confirm': async () =>
      call(
        w,
        'POST',
        `/management/requests/${await anAppointment()}/appointment/confirm`,
        { token: w.a.tokens.manager },
      ),
    'POST /management/requests/{id}/appointment/propose': async () => {
      const id = await anAppointment();
      return call(w, 'POST', `/management/requests/${id}/appointment/propose`, {
        token: w.a.tokens.manager,
        body: { startsAt: await aSlot(), mode: 'in_person' },
      });
    },
    'POST /management/requests/{id}/appointment/cancel': async () =>
      call(
        w,
        'POST',
        `/management/requests/${await anAppointment()}/appointment/cancel`,
        { token: w.a.tokens.manager, body: { reasonCode: 'office_closed' } },
      ),
    'GET /management/request-ratings': async () => {
      const id = await aClosedRequest();
      await call(w, 'POST', `/management-requests/${id}/rating`, {
        token: w.a.tokens.owner,
        body: { rating: 4 },
      }).expect(201);
      return call(w, 'GET', '/management/request-ratings', {
        token: w.a.tokens.manager,
      });
    },
    'GET /management/requests/{id}/rating': async () =>
      call(w, 'GET', `/management/requests/${await aClosedRequest()}/rating`, {
        token: w.a.tokens.manager,
      }),
    'GET /management/request-topics': () =>
      call(w, 'GET', '/management/request-topics', {
        token: w.a.tokens.manager,
      }),
    'POST /management/request-topics': () =>
      call(w, 'POST', '/management/request-topics', {
        token: w.a.tokens.manager,
        body: {
          key: 'no_store_topic',
          nameAr: 'موضوع',
          nameEn: 'Topic',
          targetResponseHours: 24,
        },
      }),
    'PATCH /management/request-topics/{id}': async () => {
      const topic = await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.managementRequestTopic.findFirstOrThrow({
          where: { key: 'documents' },
        }),
      );
      return call(w, 'PATCH', `/management/request-topics/${topic.id}`, {
        token: w.a.tokens.manager,
        body: { targetResponseHours: 72 },
      });
    },
    'GET /management-request-topics': () =>
      call(w, 'GET', '/management-request-topics', {
        token: w.a.tokens.owner,
      }),
    'GET /management/request-settings': () =>
      call(w, 'GET', '/management/request-settings', {
        token: w.a.tokens.manager,
      }),
    'PATCH /management/request-settings': () =>
      call(w, 'PATCH', '/management/request-settings', {
        token: w.a.tokens.manager,
        body: { autoCloseDays: 7 },
      }),
    'GET /management/office-hours': () =>
      call(w, 'GET', '/management/office-hours', {
        token: w.a.tokens.manager,
      }),
    'PUT /management/office-hours': () =>
      call(w, 'PUT', '/management/office-hours', {
        token: w.a.tokens.manager,
        body: {
          windows: [0, 1, 2, 3, 4, 6].map((weekday) => ({
            weekday,
            startMinute: 540,
            endMinute: 1020,
          })),
        },
      }),
    // Not a secret, but live: a cached answer would show a closed gate open.
    'GET /gates/status': () =>
      call(w, 'GET', '/gates/status', { token: w.a.tokens.owner }),
    // A resident's parcels carry the label, the photos and the codes (ADR 0035).
    'GET /me/parcels': async () => {
      await aParcel();
      return call(w, 'GET', '/me/parcels', { token: w.a.tokens.owner });
    },
    'GET /me/parcels/{id}': async () =>
      call(w, 'GET', `/me/parcels/${await aParcel()}`, {
        token: w.a.tokens.owner,
      }),
    'POST /me/parcels/{id}/reject': async () =>
      call(w, 'POST', `/me/parcels/${await aParcel()}/reject`, {
        token: w.a.tokens.owner,
        body: { reasonCode: 'other' },
      }),
    'POST /me/parcels/{id}/delegate': async () =>
      call(w, 'POST', `/me/parcels/${await aParcel()}/delegate`, {
        token: w.a.tokens.owner,
        body: { name: 'Karim' },
      }),
    'POST /auth/otp/verify': async () => (await login()).verify,
    'POST /auth/select-account': async () => (await login()).select,
    'POST /auth/refresh': async () => (await login()).refresh,
    'POST /platform/auth/login': () => platform(false),
    'POST /platform/auth/change-password': async () => {
      const restricted = body<{ accessToken: string }>(
        await platform(true),
      ).accessToken;
      return call(w, 'POST', '/platform/auth/change-password', {
        token: restricted,
        body: {
          currentPassword: 'no-store-password-1',
          newPassword: 'no-store-password-2',
        },
      });
    },
    'POST /platform/auth/refresh': async () =>
      call(w, 'POST', '/platform/auth/refresh', {
        body: {
          refreshToken: body<{ refreshToken: string }>(await platform(false))
            .refreshToken,
        },
      }),
    'POST /registration-links': () =>
      call(w, 'POST', '/registration-links', { token: w.a.tokens.manager }),
    'POST /units/{unitId}/household/invites': () =>
      call(w, 'POST', `/units/${w.a.homeUnitId}/household/invites`, {
        token: w.a.tokens.owner,
        body: inviteBody(),
      }),
    'POST /household/members/{id}/majority-invite': async () => {
      const minor = await call(
        w,
        'POST',
        `/units/${w.a.homeUnitId}/household/minors`,
        {
          token: w.a.tokens.owner,
          body: minorBody(),
        },
      ).expect(201);
      const id = body<{ id: string }>(minor).id;
      await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.householdMember.update({
          where: { id },
          data: { birthDate: bornYearsAgo(18, 1) },
        }),
      );
      return call(w, 'POST', `/household/members/${id}/majority-invite`, {
        token: w.a.tokens.owner,
        body: { email: uniqueEmail('adult'), phone: uniquePhone() },
      });
    },
    'POST /worker-engagements/{id}/review': async () =>
      (await activeEngagement()).review,
    'POST /worker-engagements/{id}/resume': async () => {
      const { id } = await activeEngagement();
      await call(w, 'POST', `/worker-engagements/${id}/suspend`, {
        token: w.a.tokens.owner,
        body: { reasonCode: 'leave', reason: 'Away' },
      }).expect(204);
      return call(w, 'POST', `/worker-engagements/${id}/resume`, {
        token: w.a.tokens.owner,
      });
    },
    'POST /worker-engagements/{id}/reissue-code': async () => {
      const { id } = await activeEngagement();
      return call(w, 'POST', `/worker-engagements/${id}/reissue-code`, {
        token: w.a.tokens.owner,
        body: { reasonCode: 'lost' },
      });
    },
    'POST /worker-engagements/{id}/card-incident': async () => {
      const { id } = await activeEngagement();
      return call(w, 'POST', `/worker-engagements/${id}/card-incident`, {
        token: w.a.tokens.manager,
        body: { type: 'confiscated' },
      });
    },
    'POST /units/{unitId}/visitor-passes': () =>
      call(w, 'POST', `/units/${w.a.homeUnitId}/visitor-passes`, {
        token: w.a.tokens.owner,
        body: passBody(),
      }),
    'POST /public/visitor-passes/lookup': async () =>
      call(w, 'POST', '/public/visitor-passes/lookup', {
        body: { token: await linkToken() },
      }),
    'POST /public/visitor-passes/not-me': async () =>
      call(w, 'POST', '/public/visitor-passes/not-me', {
        body: { token: await linkToken() },
      }),
    'POST /visitor-passes/{id}/reissue-link': async () => {
      const pass = await call(
        w,
        'POST',
        `/units/${w.a.homeUnitId}/visitor-passes`,
        { token: w.a.tokens.owner, body: passBody() },
      ).expect(201);
      return call(
        w,
        'POST',
        `/visitor-passes/${body<{ id: string }>(pass).id}/reissue-link`,
        { token: w.a.tokens.owner },
      );
    },
    'GET /worker-engagements/{id}': () =>
      call(w, 'GET', `/worker-engagements/${w.bEngagementId}`, {
        token: w.b.tokens.manager,
      }),
    'POST /gate/verify': () =>
      call(w, 'POST', '/gate/verify', {
        token: w.a.tokens.guard,
        body: { code: '00000000' },
      }),
    // A parcel's lookup names a delegate; its hand-over answers with the name too
    // (ADR 0035).
    'POST /gate/parcels/lookup': () =>
      call(w, 'POST', '/gate/parcels/lookup', {
        token: w.a.tokens.guard,
        body: { code: '000000' },
      }),
    'POST /gate/parcels/{id}/handover': async () => {
      const id = await aParcel();
      const holder = await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.parcelCredential.findFirstOrThrow({
          where: { parcelId: id, kind: 'holder' },
        }),
      );
      const { code } = h.moduleRef
        .get(ParcelTokens)
        .secretOf(w.a.tenantId, holder.id, holder.attempt);
      return call(w, 'POST', `/gate/parcels/${id}/handover`, {
        token: w.a.tokens.guard,
        body: { code },
      });
    },
    // Presigned URLs (ADR 0029): an upload target, a read URL.
    'POST /files/uploads': () =>
      call(w, 'POST', '/files/uploads', {
        token: w.a.tokens.owner,
        body: { purpose: 'worker_photo', contentType: 'image/png', size: 10 },
      }),
    // The entry credential's secret, once (ADR 0031).
    'POST /me/entry-credentials': () =>
      call(w, 'POST', '/me/entry-credentials', {
        token: w.a.tokens.tenant,
        body: {},
      }),
    'GET /me': async () => call(w, 'GET', '/me', { token: w.a.tokens.owner }),
    // A ticket's detail carries its photos' presigned URLs (ADR 0032).
    'GET /tickets/{id}': async () =>
      call(w, 'GET', `/tickets/${await aTicket()}`, {
        token: w.a.tokens.owner,
      }),
    'GET /technician/tickets/{id}': async () => {
      const id = await aTicket();
      await call(w, 'POST', `/maintenance/tickets/${id}/assign`, {
        token: w.a.tokens.manager,
        body: { technicianId: w.a.ids.technician },
      }).expect(204);
      return call(w, 'GET', `/technician/tickets/${id}`, {
        token: w.a.tokens.technician,
      });
    },
    'GET /maintenance/tickets/{id}': async () =>
      call(w, 'GET', `/maintenance/tickets/${await aTicket()}`, {
        token: w.a.tokens.manager,
      }),
    // ADR 0038.
    'GET /preventive-slots': async () =>
      await call(w, 'GET', '/preventive-slots', {
        token: w.a.tokens.owner,
        query: { unitId: w.a.homeUnitId, days: '1' },
      }),
    'GET /tickets/{id}/visit-slots': async () =>
      call(w, 'GET', `/tickets/${(await aVisit()).ticketId}/visit-slots`, {
        token: w.a.tokens.owner,
        query: { days: '1' },
      }),
    'GET /tickets/{id}/visits': async () =>
      call(w, 'GET', `/tickets/${(await aVisit()).ticketId}/visits`, {
        token: w.a.tokens.owner,
      }),
    'GET /technician/tickets/{id}/visits': async () =>
      call(
        w,
        'GET',
        `/technician/tickets/${(await aVisit()).ticketId}/visits`,
        { token: w.a.tokens.technician },
      ),
    'POST /technician/tickets/{id}/visits/{visitId}/arrive': async () => {
      const { ticketId, visitId } = await aVisit(true);
      return call(
        w,
        'POST',
        `/technician/tickets/${ticketId}/visits/${visitId}/arrive`,
        { token: w.a.tokens.technician },
      );
    },
    'GET /maintenance/tickets/{id}/visits': async () =>
      call(
        w,
        'GET',
        `/maintenance/tickets/${(await aVisit()).ticketId}/visits`,
        { token: w.a.tokens.manager },
      ),
    'GET /me/units/{unitId}/visits': async () => {
      await aVisit();
      return call(w, 'GET', `/me/units/${w.a.homeUnitId}/visits`, {
        token: w.a.tokens.owner,
      });
    },
    'GET /files/{id}': async () =>
      call(w, 'GET', `/files/${await fileHelpers(h).ready(w.a.tokens.owner)}`, {
        token: w.a.tokens.owner,
      }), // A parcel's photos, as short-lived URLs (ADR 0035).
    'GET /gate/parcels/{id}': async () =>
      call(w, 'GET', `/gate/parcels/${await aParcel()}`, {
        token: w.a.tokens.guard,
      }),
    // Personal-data export (ADR 0036): the archive's presigned URL.
    'GET /me/data-exports/{id}/download': async () => {
      const id = newId();
      await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.dataExport.create({
          data: {
            id,
            tenantId: w.a.tenantId,
            accountId: w.a.ids.owner,
            requestedByAccountId: w.a.ids.owner,
            delivery: 'in_app',
          },
        }),
      );
      await buildExports(h);
      return call(w, 'GET', `/me/data-exports/${id}/download`, {
        token: w.a.tokens.owner,
      });
    },
    'POST /public/data-exports/code': async () =>
      call(w, 'POST', '/public/data-exports/code', {
        body: { token: (await assistedLink()).token },
      }),
    'POST /public/data-exports/download': async () => {
      const { token, email } = await assistedLink();
      const since = new Date();
      await call(w, 'POST', '/public/data-exports/code', {
        body: { token },
      }).expect(202);
      return call(w, 'POST', '/public/data-exports/download', {
        body: { token, code: await waitForOtp(email, since) },
      });
    },
  };

  const secretRows = ROUTES.filter((r) => r.noStore).map(
    (r) => `${r.method} ${r.path}`,
  );

  it('has a real call for every no-store row', () => {
    expect(Object.keys(CALLS).sort()).toEqual([...secretRows].sort());
  });

  it.each(secretRows)('%s answers no-store', async (key) => {
    const res = await CALLS[key]();
    expect({
      key,
      status: res.status < 300,
      cache: res.headers['cache-control'],
    }).toEqual({
      key,
      status: true,
      cache: 'no-store',
    });
  });

  it('a response without a secret is not marked', async () => {
    const res = await call(w, 'GET', '/me/units', {
      token: w.a.tokens.owner,
    }).expect(200);
    expect(res.headers['cache-control']).toBeUndefined();
  });
});
