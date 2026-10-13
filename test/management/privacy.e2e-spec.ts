import { ClsService } from 'nestjs-cls';
import {
  catalogProblems,
  CODE_ACCESS_CATALOG,
  type AccessCatalog,
} from '../../src/core/access/access-catalog';
import { RoleLifecycle } from '../../src/core/access/role-lifecycle';
import { RolesService } from '../../src/core/access/roles.service';
import { AuditService } from '../../src/core/audit/audit.service';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { PermissionSyncService } from '../../src/core/platform/permission-sync.service';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import { eraseNow } from '../setup/erasure';
import { buildExports, readArchive, stepUp } from '../setup/exports';
import { fileHelpers } from '../setup/files';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  managementHelpers,
  type ManagementSetUp,
  type Who,
} from '../setup/management';

/**
 * ADR 0039 with ADR 0023 and 0036: what a personal-data export holds of a
 * person's requests, what an erasure takes off them (their words, as on
 * tickets) and leaves (the request, pointing at a tombstone), and what
 * happens to the requests of a handler who can no longer handle them.
 */
describe('Management requests — export, erasure and handlers who leave', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof managementHelpers>;
  let f: ReturnType<typeof fileHelpers>;
  let s: ManagementSetUp;
  let handler: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = managementHelpers(h);
    f = fileHelpers(h);
    s = await m.setUp();
    handler = await m.handler(s.c);
  }, 120_000);

  afterAll(() => h.close());

  /** A resident of the unit who is not its primary: can be erased. */
  async function resident() {
    const p = await m.x.resident(s.c, [s.unit.id]);
    return { ...p, ...(await m.who(s.c, p.id, 'resident')) };
  }
  const staff = (id: string, action: string, body?: object, who = handler) =>
    m.http('post', `/management/requests/${id}/${action}`, who.token, body);
  const row = (id: string) =>
    m.x.asManager(s.c, () =>
      m.x.prisma.tenant.managementRequest.findUniqueOrThrow({ where: { id } }),
    );

  describe('the personal-data export', () => {
    it('holds the account’s own requests with their conversation, appointments and rating — and no staff note, no other person’s request, no file', async () => {
      const p = await resident();
      const other = await resident();
      const topicId = await m.topicId(s.c);
      const mine = (id: string, action: string, body?: object) =>
        m.http('post', `/management-requests/${id}/${action}`, p.token, body);

      // A question, answered, closed and rated, with a file and a note.
      const photo = await f.ready(p.token, 'request_attachment', 'image/png');
      const question = await m.open(s.c, p, {
        body: 'EXPORT-MY-QUESTION',
        attachmentFileIds: [photo],
      });
      const notePdf = await f.ready(
        handler.token,
        'request_attachment',
        'application/pdf',
      );
      await staff(question.id, 'messages', {
        body: 'EXPORT-STAFF-NOTE',
        internal: true,
        attachmentFileIds: [notePdf],
      }).expect(201);
      await staff(question.id, 'messages', {
        body: 'EXPORT-STAFF-ANSWER',
        official: true,
      }).expect(201);
      await staff(question.id, 'close', { reasonCode: 'resolved' }).expect(204);
      await mine(question.id, 'rating', {
        rating: 4,
        comment: 'EXPORT-MY-COMMENT',
      }).expect(201);

      // An appointment that was countered and accepted.
      const slots = (await m.slots(p, 31)).map((x) => x.startsAt);
      const booked = await m
        .book(s.c, p, slots[0], topicId, { body: 'EXPORT-MY-APPOINTMENT' })
        .expect(201);
      const appointmentId = (booked.body as { id: string }).id;
      await staff(appointmentId, 'appointment/propose', {
        startsAt: slots[1],
        mode: 'phone',
      }).expect(201);
      await mine(appointmentId, 'appointment/accept').expect(204);

      // Someone else's request, and one opened for the account by staff.
      await m.open(s.c, other, { body: 'EXPORT-OTHER-PERSON' });
      await m
        .http('post', '/management/requests', s.manager.token, {
          type: 'general',
          topicId,
          authorAccountId: p.id,
          reasonCode: 'resident_walk_in',
          body: 'EXPORT-TAKEN-DOWN-FOR-ME',
        })
        .expect(201);

      await stepUp(h, p.token, p.email);
      const asked = await h
        .http()
        .post(`${API}/me/data-exports`)
        .set('Authorization', `Bearer ${p.token}`)
        .send({})
        .expect(201);
      await buildExports(h);
      const dl = await h
        .http()
        .get(
          `${API}/me/data-exports/${(asked.body as { id: string }).id}/download`,
        )
        .set('Authorization', `Bearer ${p.token}`)
        .expect(200);
      const archive = await readArchive((dl.body as { url: string }).url);

      const entries = archive.names.filter((n) =>
        n.startsWith('management-requests/'),
      );
      expect(entries).toHaveLength(3);
      expect(entries).toContain(`management-requests/${question.number}.json`);

      const q = JSON.parse(
        archive.text(`management-requests/${question.number}.json`),
      ) as {
        number: string;
        status: string;
        rating: { rating: number; comment: string };
        messages: {
          body: string;
          attachmentCount: number;
          official: boolean;
        }[];
        appointments: unknown[];
      };
      expect(q).toMatchObject({
        number: question.number,
        status: 'closed',
        closeReason: 'resolved',
        rating: { rating: 4, comment: 'EXPORT-MY-COMMENT' },
        appointments: [],
      });
      // The conversation as the author reads it: no note among the messages.
      expect(
        q.messages.map((x) => [x.body, x.attachmentCount, x.official]),
      ).toEqual([
        ['EXPORT-MY-QUESTION', 1, false],
        ['EXPORT-STAFF-ANSWER', 0, true],
      ]);
      expect(q).not.toHaveProperty('appointment');

      const a = JSON.parse(
        archive.text(
          `management-requests/${(booked.body as { number: string }).number}.json`,
        ),
      ) as {
        appointments: { status: string; mode: string; proposedBy: string }[];
      };
      expect(
        a.appointments.map((x) => [x.status, x.mode, x.proposedBy]),
      ).toEqual([
        ['superseded', 'in_person', 'resident'],
        ['confirmed', 'phone', 'staff'],
      ]);

      // Everything the account wrote or was written for it, and nothing else.
      for (const text of [
        'EXPORT-MY-QUESTION',
        'EXPORT-STAFF-ANSWER',
        'EXPORT-MY-COMMENT',
        'EXPORT-MY-APPOINTMENT',
        'EXPORT-TAKEN-DOWN-FOR-ME',
      ])
        expect(archive.all).toContain(text);
      expect(archive.all).not.toContain('EXPORT-STAFF-NOTE');
      expect(archive.all).not.toContain('EXPORT-OTHER-PERSON');
      // No URL of an attachment, no file of a request, and nothing of the
      // staff's side of a request.
      const requests = entries.map((n) => archive.text(n)).join('\n');
      expect(requests).not.toMatch(/X-Amz-Signature|"url"|"internal"/);
      expect(requests).not.toMatch(
        /"assignee"|"overdue"|"escalat|"preview"|"onBehalfReason"|"fullName"/,
      );
      expect(archive.names.filter((n) => n.includes(photo))).toEqual([]);
    });
  });

  describe('erasure', () => {
    it('takes the person’s words off their requests — messages and the rating’s comment — and leaves the requests, the staff’s words and the files', async () => {
      const p = await resident();
      const mine = (id: string, action: string, body?: object) =>
        m.http('post', `/management-requests/${id}/${action}`, p.token, body);
      const photo = await f.ready(p.token, 'request_attachment', 'image/png');
      const { id, number } = await m.open(s.c, p, {
        unitId: s.unit.id,
        body: 'ERASE-ME first message',
        attachmentFileIds: [photo],
      });
      await staff(id, 'messages', { body: 'Staff reply stays' }).expect(201);
      await mine(id, 'messages', { body: 'ERASE-ME second message' }).expect(
        201,
      );
      await staff(id, 'messages', {
        body: 'Staff note stays',
        internal: true,
      }).expect(201);
      await staff(id, 'close', { reasonCode: 'resolved' }).expect(204);
      await mine(id, 'rating', {
        rating: 2,
        comment: 'ERASE-ME comment',
      }).expect(201);
      // Taken down for them by staff: staff's message, about them.
      const onBehalf = await m
        .http('post', '/management/requests', s.manager.token, {
          type: 'general',
          topicId: await m.topicId(s.c),
          authorAccountId: p.id,
          reasonCode: 'resident_phone_call',
          body: 'Taken down by staff',
        })
        .expect(201);

      await eraseNow(h, s.c, p.id);

      const read = await m.x.asManager(s.c, async () => ({
        messages: await m.x.prisma.tenant.managementRequestMessage.findMany({
          where: { requestId: id },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            senderId: true,
            body: true,
            erasedAt: true,
            internal: true,
          },
        }),
        rating:
          await m.x.prisma.tenant.managementRequestRating.findFirstOrThrow({
            where: { requestId: id },
          }),
        file: await m.x.prisma.tenant.storedFile.findUniqueOrThrow({
          where: { id: photo },
        }),
        attachments: await m.x.prisma.tenant.managementRequestAttachment.count({
          where: { requestId: id },
        }),
        account: await m.x.prisma.tenant.account.findUniqueOrThrow({
          where: { id: p.id },
        }),
      }));
      expect(read.account).toMatchObject({ status: 'erased', fullName: null });
      expect(read.messages).toEqual([
        {
          senderId: p.id,
          body: null,
          erasedAt: expect.any(Date) as Date,
          internal: false,
        },
        {
          senderId: handler.id,
          body: 'Staff reply stays',
          erasedAt: null,
          internal: false,
        },
        {
          senderId: p.id,
          body: null,
          erasedAt: expect.any(Date) as Date,
          internal: false,
        },
        {
          senderId: handler.id,
          body: 'Staff note stays',
          erasedAt: null,
          internal: true,
        },
      ]);
      expect(read.rating).toMatchObject({
        authorId: p.id,
        rating: 2,
        comment: null,
      });
      // The request stays whole, pointing at the tombstone; so does its file.
      expect(await row(id)).toMatchObject({
        authorId: p.id,
        status: 'closed',
        closeReason: 'resolved',
        unitId: s.unit.id,
      });
      expect(read.attachments).toBe(1);
      expect(read.file).toMatchObject({
        deletedAt: null,
        ownerAccountId: null,
      });

      // Staff read it as erased: no name, no words, no preview.
      const detail = await m
        .http('get', `/management/requests/${id}`, handler.token)
        .expect(200);
      expect((detail.body as { author: unknown }).author).toEqual({
        id: p.id,
        erased: true,
      });
      const thread = (
        (
          await m
            .http('get', `/management/requests/${id}/messages`, handler.token)
            .expect(200)
        ).body as {
          data: { body: string | null; erased: boolean; sender: unknown }[];
        }
      ).data;
      expect(thread.map((x) => [x.body, x.erased])).toEqual([
        [null, true],
        ['Staff reply stays', false],
        [null, true],
        ['Staff note stays', false],
      ]);
      expect(thread[0].sender).toEqual({ id: p.id, erased: true });
      const inbox = (
        (
          await m
            .http('get', '/management/requests?limit=100', handler.token)
            .expect(200)
        ).body as { data: { number: string; preview: string | null }[] }
      ).data;
      expect(inbox.find((r) => r.number === number)!.preview).toBeNull();
      const rating = await m
        .http('get', `/management/requests/${id}/rating`, s.manager.token)
        .expect(200);
      expect(rating.body).toMatchObject({
        rating: { rating: 2, comment: null },
      });
      const everything = JSON.stringify([
        detail.body,
        thread,
        inbox,
        rating.body,
      ]);
      expect(everything).not.toContain('ERASE-ME');
      // What staff wrote for them is staff's message: it stays, as a
      // dispatcher's description of a ticket does.
      const taken = (
        (
          await m
            .http(
              'get',
              `/management/requests/${(onBehalf.body as { id: string }).id}/messages`,
              handler.token,
            )
            .expect(200)
        ).body as { data: { body: string | null }[] }
      ).data;
      expect(taken.map((x) => x.body)).toEqual(['Taken down by staff']);
      // Erased means erased: the token no longer opens anything.
      await m.http('get', '/management-requests', p.token).expect(401);
    });

    it('a staff member who leaves hands their request back when deactivated; their erasure then takes their words too, notes included', async () => {
      const leaving = await m.handler(s.c);
      const { id } = await m.open(s.c, s.owner, { body: 'A question' });
      await staff(id, 'assign', { assigneeId: leaving.id }, s.manager).expect(
        204,
      );
      await staff(id, 'messages', { body: 'ERASE-ME reply' }, leaving).expect(
        201,
      );
      await staff(
        id,
        'messages',
        { body: 'ERASE-ME note', internal: true },
        leaving,
      ).expect(201);
      // An active staff account is not erased (ADR 0036): deactivated first,
      // which already hands its request back.
      await m.x.asManager(s.c, () =>
        h.moduleRef
          .get(AccountsService)
          .updateStatus(leaving.id, { status: 'inactive' }),
      );
      expect((await row(id)).assigneeId).toBeNull();
      const [audit] = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.auditLog.findMany({
          where: { action: 'management_request.unassigned', targetId: id },
        }),
      );
      expect(audit.metadata).toMatchObject({
        reasonCode: 'account_deactivated',
      });
      await eraseNow(h, s.c, leaving.id);
      const messages = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.managementRequestMessage.findMany({
          where: { requestId: id },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { body: true },
        }),
      );
      expect(messages.map((x) => x.body)).toEqual(['A question', null, null]);
      expect((await row(id)).assigneeId).toBeNull();
      // The author's thread shows the reply as erased, and still no note.
      const mineThread = (
        (
          await m
            .http('get', `/management-requests/${id}/messages`, s.owner.token)
            .expect(200)
        ).body as { data: { body: string | null; erased: boolean }[] }
      ).data;
      expect(mineThread.map((x) => [x.body, x.erased])).toEqual([
        ['A question', false],
        [null, true],
      ]);
    });
  });

  describe('a handler who can no longer handle requests', () => {
    const assignedTo = async (who: Who) => {
      const live = await m.open(s.c, s.owner);
      const closed = await m.open(s.c, s.owner);
      for (const { id } of [live, closed])
        await staff(id, 'assign', { assigneeId: who.id }, s.manager).expect(
          204,
        );
      await staff(
        closed.id,
        'close',
        { reasonCode: 'resolved' },
        s.manager,
      ).expect(204);
      return { live: live.id, closed: closed.id };
    };
    const released = (id: string) =>
      m.x.asManager(s.c, () =>
        m.x.prisma.tenant.auditLog.findMany({
          where: { action: 'management_request.unassigned', targetId: id },
        }),
      );
    const expectReleased = async (
      ids: { live: string; closed: string },
      who: Who,
      reasonCode: string,
    ) => {
      expect((await row(ids.live)).assigneeId).toBeNull();
      // A closed request keeps the name of who handled it.
      expect((await row(ids.closed)).assigneeId).toBe(who.id);
      const audits = await released(ids.live);
      expect(audits).toHaveLength(1);
      expect(audits[0].changes).toEqual({
        assigneeId: { from: who.id, to: null },
      });
      expect(audits[0].metadata).toMatchObject({ reasonCode });
      expect(await released(ids.closed)).toEqual([]);
    };

    it('frozen: their live requests go back to the queue, audited with the reason', async () => {
      const who = await m.handler(s.c);
      const ids = await assignedTo(who);
      await m.x.asManager(s.c, () =>
        h.moduleRef
          .get(AccountsService)
          .freeze(who.id, { code: 'phone_reassigned', text: 'Test' }),
      );
      await expectReleased(ids, who, 'account_frozen');
    });

    it('the role loses requests.handle: every account of the role gives its requests back, and none can be assigned to them', async () => {
      const who = await m.handler(s.c);
      const ids = await assignedTo(who);
      const role = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.role.findUniqueOrThrow({
          where: {
            tenantId_key: {
              tenantId: s.c.tenantId,
              key: 'maintenance_supervisor',
            },
          },
        }),
      );
      await m.x.asManager(s.c, () =>
        h.moduleRef.get(RolesService).replacePermissions(role.id, []),
      );
      await expectReleased(ids, who, 'role_lost');
      const res = await staff(
        ids.live,
        'assign',
        { assigneeId: who.id },
        s.manager,
      ).expect(400);
      expect(res.body).toMatchObject({
        fields: [{ field: 'assigneeId', code: 'ASSIGNEE_NOT_ELIGIBLE' }],
      });
      // And they are no longer told of new requests.
      const fresh = await m.open(s.c, s.owner);
      const told = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.notification.findMany({
          where: { targetId: fresh.id },
          select: { accountId: true },
        }),
      );
      expect(told.map((n) => n.accountId)).not.toContain(who.id);
      // Put the permission back for the suites below.
      await m.x.asManager(s.c, () =>
        h.moduleRef
          .get(RolesService)
          .replacePermissions(role.id, ['requests.handle']),
      );
    });

    it('access:sync narrows who may hold requests.handle: the revoked role’s requests go back too, by the system', async () => {
      const who = await m.handler(s.c);
      const ids = await assignedTo(who);
      // The catalog of a later deploy: requests.handle is the manager's alone.
      const narrowed: AccessCatalog = {
        ...CODE_ACCESS_CATALOG,
        permissions: {
          ...CODE_ACCESS_CATALOG.permissions,
          'requests.handle': { kinds: ['manager'] },
        },
      };
      expect(catalogProblems(narrowed)).toEqual([]);
      // The sync as a deploy runs it, on the app's own lifecycle hooks.
      const report = await new PermissionSyncService(
        narrowed,
        h.moduleRef.get(GlobalDbService),
        h.moduleRef.get(TenantTx),
        h.moduleRef.get(AuditService),
        h.moduleRef.get(RoleLifecycle),
        h.moduleRef.get(ClsService),
      ).syncTenant(s.c.tenantId);
      expect(report.revoked).toEqual([
        {
          roleKey: 'maintenance_supervisor',
          kind: 'staff',
          permission: 'requests.handle',
        },
      ]);
      await expectReleased(ids, who, 'role_lost');
      const [audit] = await released(ids.live);
      expect(audit).toMatchObject({ actorType: 'system', actorId: null });
      // The manager still holds it, and still has what was theirs.
      const mine = await m.open(s.c, s.owner);
      await staff(
        mine.id,
        'assign',
        { assigneeId: s.manager.id },
        s.manager,
      ).expect(204);
      // A second run revokes nothing and releases nothing.
      const again = await new PermissionSyncService(
        narrowed,
        h.moduleRef.get(GlobalDbService),
        h.moduleRef.get(TenantTx),
        h.moduleRef.get(AuditService),
        h.moduleRef.get(RoleLifecycle),
        h.moduleRef.get(ClsService),
      ).syncTenant(s.c.tenantId);
      expect(again.revoked).toEqual([]);
      expect((await row(mine.id)).assigneeId).toBe(s.manager.id);
      // Put the permission back for the suites below (the code's own catalog
      // still allows it to a staff role).
      const role = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.role.findUniqueOrThrow({
          where: {
            tenantId_key: {
              tenantId: s.c.tenantId,
              key: 'maintenance_supervisor',
            },
          },
        }),
      );
      await m.x.asManager(s.c, () =>
        h.moduleRef
          .get(RolesService)
          .replacePermissions(role.id, ['requests.handle']),
      );
    });
  });

  describe('an author who loses access to the compound', () => {
    it('reads nothing on the resident side once frozen; the request stays for the staff', async () => {
      const p = await resident();
      const { id } = await m.open(s.c, p, { body: 'Before I was frozen' });
      await m.http('get', `/management-requests/${id}`, p.token).expect(200);
      await m.x.asManager(s.c, () =>
        h.moduleRef
          .get(AccountsService)
          .freeze(p.id, { code: 'phone_reassigned', text: 'Test' }),
      );
      for (const path of [
        '/management-requests',
        `/management-requests/${id}`,
        `/management-requests/${id}/messages`,
        '/me/requests',
      ]) {
        const res = await m.http('get', path, p.token);
        expect([401, 403]).toContain(res.status);
      }
      const res = await m.http(
        'post',
        `/management-requests/${id}/messages`,
        p.token,
        { body: 'Still here?' },
      );
      expect([401, 403]).toContain(res.status);
      await m
        .http('get', `/management/requests/${id}`, handler.token)
        .expect(200);
    });
  });
});
