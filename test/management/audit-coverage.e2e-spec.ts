import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { ESCALATION_SWEEP } from '../../src/management/requests/escalation.service';
import { AUTO_CLOSE_SWEEP } from '../../src/management/requests/lifecycle.service';
import { auditReaders } from '../setup/audit';
import {
  COMMUNITY_COVERAGE,
  FILES_COVERAGE,
  MAINTENANCE_COVERAGE,
  MANAGEMENT_COVERAGE,
  PARCELS_COVERAGE,
  PHASE_2_2_COVERAGE,
  PHASE_4_COVERAGE,
  R1_COVERAGE,
  RESIDENT_SCREENS_COVERAGE,
} from '../setup/audit-coverage-split';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { managementHelpers, type ManagementSetUp } from '../setup/management';

/**
 * One scenario per management catalog entry (ADR 0014, 0039): actor, target,
 * changes and metadata — ids, numbers, keys and reason codes; never a
 * message, a note, a rating's comment or a topic's name.
 */
const covered = new Set<string>();

/** Planted in every free text a scenario writes: no audit row may hold it. */
const MARKER = 'AUDIT-FREE-TEXT';

describe('Audit coverage — management requests', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof managementHelpers>;
  let s: ManagementSetUp;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = managementHelpers(h);
    s = await m.setUp();
    read = auditReaders(h);
  }, 60_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const rows = await read.tenant(s.c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    expect(JSON.stringify(rows[0])).not.toContain(MARKER);
    return rows[0];
  }

  describe('set-up', () => {
    let topicId: string;

    it('management_request_topic.created — the key and target by value, the names as changed', async () => {
      const res = await m
        .http('post', '/management/request-topics', s.manager.token, {
          key: 'pool',
          nameAr: `${MARKER} ع`,
          nameEn: `${MARKER} Pool`,
          targetResponseHours: 12,
        })
        .expect(201);
      topicId = (res.body as { id: string }).id;
      const row = await single('management_request_topic.created', topicId);
      expect(row).toMatchObject({
        actorType: 'account',
        actorId: s.manager.id,
        targetType: 'management_request_topic',
      });
      expect(row.changes).toEqual({
        key: { from: null, to: 'pool' },
        nameAr: { changed: true },
        nameEn: { changed: true },
        targetResponseHours: { from: null, to: 12 },
        active: { from: null, to: true },
      });
    });

    it('management_request_topic.updated — only what changed; nothing when nothing did', async () => {
      const patch = (body: object) =>
        m
          .http(
            'patch',
            `/management/request-topics/${topicId}`,
            s.manager.token,
            body,
          )
          .expect(200);
      await patch({
        nameEn: `${MARKER} Pool area`,
        targetResponseHours: 24,
        active: false,
      });
      const row = await single('management_request_topic.updated', topicId);
      expect(row.changes).toEqual({
        nameEn: { changed: true },
        targetResponseHours: { from: 12, to: 24 },
        active: { from: true, to: false },
      });
      // The same values again: no row.
      await patch({ targetResponseHours: 24, active: false });
      expect(
        await read.tenant(s.c.tenantId, {
          action: 'management_request_topic.updated',
          targetId: topicId,
        }),
      ).toHaveLength(1);
    });

    it('management.settings_changed — the fields that changed, by value', async () => {
      const patch = (body: object) =>
        m
          .http('patch', '/management/request-settings', s.manager.token, body)
          .expect(200);
      await patch({ autoCloseDays: 14, appointmentSlotCapacity: 3 });
      const row = await single('management.settings_changed', s.c.tenantId);
      expect(row).toMatchObject({
        actorId: s.manager.id,
        targetType: 'tenant',
      });
      expect(row.changes).toEqual({
        autoCloseDays: { from: 7, to: 14 },
        appointmentSlotCapacity: { from: 1, to: 3 },
      });
      await patch({ autoCloseDays: 14 });
      expect(
        await read.tenant(s.c.tenantId, {
          action: 'management.settings_changed',
          targetId: s.c.tenantId,
        }),
      ).toHaveLength(1);
    });

    it('management.office_hours_changed — the set before and after, as numbers', async () => {
      const windows = [{ weekday: 1, startMinute: 600, endMinute: 720 }];
      const put = () =>
        m
          .http('put', '/management/office-hours', s.manager.token, { windows })
          .expect(200);
      await put();
      const row = await single('management.office_hours_changed', s.c.tenantId);
      expect(row).toMatchObject({
        actorId: s.manager.id,
        targetType: 'tenant',
      });
      expect(row.changes).toEqual({
        windows: {
          from: [0, 1, 2, 3, 4, 6].map((d) => `${d}:540-1020`),
          to: ['1:600-720'],
        },
      });
      // The same set again: no row.
      await put();
      expect(
        await read.tenant(s.c.tenantId, {
          action: 'management.office_hours_changed',
          targetId: s.c.tenantId,
        }),
      ).toHaveLength(1);
    });
  });

  describe('requests', () => {
    let requestId: string;

    it('management_request.created — by the author: number, type, topic key, never the words', async () => {
      const created = await m.open(s.c, s.owner, {
        type: 'general',
        unitId: s.unit.id,
        body: `${MARKER} my gate remote is broken`,
      });
      requestId = created.id;
      const row = await single('management_request.created', requestId);
      expect(row).toMatchObject({
        actorType: 'account',
        actorId: s.owner.id,
        targetType: 'management_request',
      });
      expect(row.metadata).toEqual({
        requestNumber: 1,
        type: 'general',
        topicKey: 'general',
        withUnit: true,
      });
    });

    it('management_request.created_on_behalf — by the staff member, with the reason code and the author', async () => {
      const res = await m
        .http('post', '/management/requests', s.manager.token, {
          type: 'question',
          topicId: await m.topicId(s.c, 'documents'),
          authorAccountId: s.owner.id,
          reasonCode: 'resident_phone_call',
          body: `${MARKER} asked by phone`,
        })
        .expect(201);
      const { id } = res.body as { id: string };
      const row = await single('management_request.created_on_behalf', id);
      expect(row).toMatchObject({
        actorType: 'account',
        actorId: s.manager.id,
        targetType: 'management_request',
      });
      expect(row.metadata).toEqual({
        requestNumber: 2,
        type: 'question',
        topicKey: 'documents',
        withUnit: false,
        reasonCode: 'resident_phone_call',
        authorId: s.owner.id,
      });
      // Opened by staff: not also recorded as the author's own.
      expect(
        await read.tenant(s.c.tenantId, {
          action: 'management_request.created',
          targetId: id,
        }),
      ).toEqual([]);
    });

    const assign = (assigneeId: string | null) =>
      m
        .http(
          'post',
          `/management/requests/${requestId}/assign`,
          s.manager.token,
          { assigneeId },
        )
        .expect(204);

    it('management_request.assigned — from nobody to the handler; the same again records nothing', async () => {
      await assign(s.manager.id);
      const row = await single('management_request.assigned', requestId);
      expect(row).toMatchObject({ actorId: s.manager.id });
      expect(row.changes).toEqual({
        assigneeId: { from: null, to: s.manager.id },
      });
      expect(row.metadata).toEqual({ requestNumber: 1 });
      await assign(s.manager.id);
      expect(
        await read.tenant(s.c.tenantId, {
          action: 'management_request.assigned',
          targetId: requestId,
        }),
      ).toHaveLength(1);
    });

    it('management_request.unassigned — back to the queue', async () => {
      await assign(null);
      const row = await single('management_request.unassigned', requestId);
      expect(row.changes).toEqual({
        assigneeId: { from: s.manager.id, to: null },
      });
    });
  });

  describe('a request’s moves', () => {
    let id: string;
    const say = (who: { token: string }, staff: boolean, body: object) =>
      m
        .http(
          'post',
          `${staff ? '/management/requests' : '/management-requests'}/${id}/messages`,
          who.token,
          body,
        )
        .expect(201);
    const moves = (action: string) =>
      read.tenant(s.c.tenantId, { action, targetId: id });

    beforeAll(async () => {
      id = (await m.open(s.c, s.owner, { body: `${MARKER} question` })).id;
    });

    it('a message that moves nothing is not audited: the author’s on an open request, a staff note', async () => {
      await say(s.owner, false, { body: `${MARKER} more` });
      await say(s.manager, true, { body: `${MARKER} note`, internal: true });
      for (const action of [
        'management_request.started',
        'management_request.answered',
        'management_request.resumed',
      ])
        expect(await moves(action)).toEqual([]);
    });

    it('management_request.started — by the first staff reply, once', async () => {
      await say(s.manager, true, { body: `${MARKER} looking` });
      const row = await single('management_request.started', id);
      expect(row).toMatchObject({
        actorType: 'account',
        actorId: s.manager.id,
        targetType: 'management_request',
      });
      expect(row.metadata).toEqual({ requestNumber: 3, cycle: 1, by: 'reply' });
      await say(s.manager, true, { body: `${MARKER} still looking` });
      expect(await moves('management_request.started')).toHaveLength(1);
    });

    it('management_request.answered — by the official reply, with the status it found', async () => {
      await say(s.manager, true, { body: `${MARKER} answer`, official: true });
      const row = await single('management_request.answered', id);
      expect(row).toMatchObject({ actorId: s.manager.id });
      expect(row.metadata).toEqual({
        requestNumber: 3,
        cycle: 1,
        fromStatus: 'in_progress',
      });
    });

    it('management_request.resumed — by the author’s reply to the answer', async () => {
      await say(s.owner, false, { body: `${MARKER} but` });
      const row = await single('management_request.resumed', id);
      expect(row).toMatchObject({ actorId: s.owner.id });
      expect(row.metadata).toEqual({
        requestNumber: 3,
        cycle: 1,
        fromStatus: 'answered',
      });
    });
  });

  describe('a request’s ends', () => {
    const DAY = 86_400_000;
    const post = (who: { token: string }, path: string, body?: object) =>
      m.http('post', path, who.token, body);

    it('management_request.closed — by staff, with the reason code and the status it left', async () => {
      const { id } = await m.open(s.c, s.owner, { body: `${MARKER} q` });
      await post(s.manager, `/management/requests/${id}/close`, {
        reasonCode: 'not_for_management',
      }).expect(204);
      const row = await single('management_request.closed', id);
      expect(row).toMatchObject({
        actorType: 'account',
        actorId: s.manager.id,
        targetType: 'management_request',
      });
      expect(row.metadata).toEqual({
        requestNumber: 4,
        cycle: 1,
        fromStatus: 'open',
        reasonCode: 'not_for_management',
      });
    });

    it('management_request.reopened — by the author: the new cycle and what it was closed as, never why they reopen', async () => {
      const [closed] = await read.tenant(s.c.tenantId, {
        action: 'management_request.closed',
      });
      const id = closed.targetId!;
      await post(s.owner, `/management-requests/${id}/reopen`, {
        body: `${MARKER} it is for you after all`,
      }).expect(204);
      const row = await single('management_request.reopened', id);
      expect(row).toMatchObject({ actorId: s.owner.id });
      expect(row.metadata).toEqual({
        requestNumber: 4,
        cycle: 2,
        closeReason: 'not_for_management',
      });
    });

    it('management_request.withdrawn — by the author, with no reason code', async () => {
      const { id } = await m.open(s.c, s.owner, { body: `${MARKER} q` });
      await post(s.owner, `/management-requests/${id}/withdraw`).expect(204);
      const row = await single('management_request.withdrawn', id);
      expect(row).toMatchObject({ actorType: 'account', actorId: s.owner.id });
      expect(row.metadata).toEqual({
        requestNumber: 5,
        cycle: 1,
        fromStatus: 'open',
      });
    });

    it('management_request.auto_closed — by the system, after the answer went unanswered', async () => {
      const { id } = await m.open(s.c, s.owner, { body: `${MARKER} q` });
      await post(s.manager, `/management/requests/${id}/messages`, {
        body: `${MARKER} the answer`,
        official: true,
      }).expect(201);
      // The compound's days were set to 14 above.
      await h.moduleRef
        .get(SweepRunner)
        .run(AUTO_CLOSE_SWEEP, new Date(Date.now() + 15 * DAY));
      const row = await single('management_request.auto_closed', id);
      expect(row).toMatchObject({
        actorType: 'system',
        actorId: null,
        targetType: 'management_request',
      });
      expect(row.metadata).toEqual({
        requestNumber: 6,
        cycle: 1,
        fromStatus: 'answered',
      });
    });
  });

  describe('escalation', () => {
    it('management_request.escalated — by the system, once for the cycle', async () => {
      const { id } = await m.open(s.c, s.owner, { body: `${MARKER} q` });
      const request = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.managementRequest.findUniqueOrThrow({
          where: { id },
        }),
      );
      const sweep = h.moduleRef.get(SweepRunner);
      await sweep.run(ESCALATION_SWEEP, request.responseDueAt);
      await sweep.run(
        ESCALATION_SWEEP,
        new Date(request.responseDueAt.getTime() + 3_600_000),
      );
      const row = await single('management_request.escalated', id);
      expect(row).toMatchObject({
        actorType: 'system',
        actorId: null,
        targetType: 'management_request',
      });
      expect(row.metadata).toEqual({ requestNumber: 7, cycle: 1 });
    });
  });

  describe('appointments', () => {
    let requestId: string;
    let number: number;
    let slots: string[];
    const appointments = () =>
      m.x.asManager(s.c, () =>
        m.x.prisma.tenant.managementAppointment.findMany({
          where: { requestId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      );

    beforeAll(async () => {
      // The office was closed by an earlier scenario: open it again.
      await m
        .http('put', '/management/office-hours', s.manager.token, {
          windows: [0, 1, 2, 3, 4, 6].map((weekday) => ({
            weekday,
            startMinute: 540,
            endMinute: 1020,
          })),
        })
        .expect(200);
      slots = (await m.slots(s.owner, 31)).map((x) => x.startsAt);
    });

    it('management_appointment.requested — the resident’s pick: mode and time, never why', async () => {
      const res = await m
        .book(s.c, s.owner, slots[0], await m.topicId(s.c), {
          body: `${MARKER} I want to talk about my neighbour`,
        })
        .expect(201);
      requestId = (res.body as { id: string }).id;
      number = Number((res.body as { number: string }).number.slice(3));
      const [appointment] = await appointments();
      const row = await single(
        'management_appointment.requested',
        appointment.id,
      );
      expect(row).toMatchObject({
        actorType: 'account',
        actorId: s.owner.id,
        targetType: 'management_appointment',
      });
      expect(row.metadata).toEqual({
        requestNumber: number,
        mode: 'in_person',
        startsAt: slots[0],
        replaces: false,
      });
    });

    it('management_appointment.proposed — staff’s counter, replacing the pick', async () => {
      await m
        .http(
          'post',
          `/management/requests/${requestId}/appointment/propose`,
          s.manager.token,
          { startsAt: slots[1], mode: 'phone' },
        )
        .expect(201);
      const [, proposed] = await appointments();
      const row = await single('management_appointment.proposed', proposed.id);
      expect(row).toMatchObject({ actorId: s.manager.id });
      expect(row.metadata).toEqual({
        requestNumber: number,
        mode: 'phone',
        startsAt: slots[1],
        replaces: true,
      });
    });

    it('management_appointment.confirmed — by the resident accepting it', async () => {
      await m
        .http(
          'post',
          `/management-requests/${requestId}/appointment/accept`,
          s.owner.token,
        )
        .expect(204);
      const [, proposed] = await appointments();
      const row = await single('management_appointment.confirmed', proposed.id);
      expect(row).toMatchObject({ actorId: s.owner.id });
      expect(row.metadata).toEqual({
        requestNumber: number,
        mode: 'phone',
        startsAt: slots[1],
        by: 'resident',
      });
    });

    it('management_appointment.cancelled — with the reason code, who and from what', async () => {
      await m
        .http(
          'post',
          `/management/requests/${requestId}/appointment/cancel`,
          s.manager.token,
          { reasonCode: 'staff_unavailable' },
        )
        .expect(204);
      const [, cancelled] = await appointments();
      const row = await single(
        'management_appointment.cancelled',
        cancelled.id,
      );
      expect(row).toMatchObject({ actorId: s.manager.id });
      expect(row.metadata).toEqual({
        requestNumber: number,
        reasonCode: 'staff_unavailable',
        by: 'staff',
        fromStatus: 'confirmed',
      });
    });
  });

  describe('catalog completeness', () => {
    it('every management entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of MANAGEMENT_COVERAGE) {
        expect(all).toContain(key);
        expect([
          ...COMMUNITY_COVERAGE,
          ...PHASE_2_2_COVERAGE,
          ...PHASE_4_COVERAGE,
          ...FILES_COVERAGE,
          ...MAINTENANCE_COVERAGE,
          ...PARCELS_COVERAGE,
          ...R1_COVERAGE,
          ...RESIDENT_SCREENS_COVERAGE,
        ]).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...MANAGEMENT_COVERAGE].sort());
    });
  });
});
