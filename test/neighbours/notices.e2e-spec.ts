import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  neighboursHelpers,
  type NeighboursSetUp,
  type Who,
} from '../setup/neighbours';

/**
 * ADR 0042: the notice to the unit complained about. What it carries (the
 * category and the staff's text, nothing of the complaint), who it goes to
 * (the household's primary and whoever holds a live household delegation;
 * the owners of a unit nobody lives in), and who still reads it later.
 */
describe('Neighbour complaints — the notice to the unit', () => {
  let h: HttpHarness;
  let n: ReturnType<typeof neighboursHelpers>;
  let s: NeighboursSetUp;
  let audit: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    n = neighboursHelpers(h);
    s = await n.setUp();
    audit = auditReaders(h);
    await n.settings(s.c, s.manager, { maxOpenComplaints: 50 });
  }, 180_000);

  afterAll(() => h.close());

  type Notice = Record<string, unknown> & { id: string };
  const notices = (who: Who) => n.list<Notice>('/neighbour-notices', who);
  const notice = (who: Who, id: string) =>
    n.http('get', `/neighbour-notices/${id}`, who.token);
  const staffDetail = async (id: string) =>
    (
      await n
        .http('get', `/neighbours/complaints/${id}`, s.handler.token)
        .expect(200)
    ).body as {
      status: string;
      notice: {
        id: string;
        body: string;
        recipientKind: string;
        recipients: { id: string }[];
        sentBy: { id: string };
      } | null;
    };

  describe('what the unit receives', () => {
    let complaintId: string;
    let complaintNumber: string;
    let noticeId: string;

    beforeAll(async () => {
      const created = await n.complain(s.c, s.alice, s.homeB.code, {
        body: 'COMPLAINT-WORDS the dog barks all night',
        attachmentFileIds: [await n.file(s.alice, 'complaint_evidence')],
      });
      complaintId = created.id;
      complaintNumber = created.number;
      noticeId = await n.noticed(
        s.handler,
        complaintId,
        'NOTICE-TEXT about the dog',
      );
    });

    it('the category and the staff’s text, and nothing else', async () => {
      const res = await notice(s.bob, noticeId).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({
        id: noticeId,
        category: {
          id: expect.any(String) as string,
          key: 'noise',
          nameAr: expect.any(String) as string,
          nameEn: 'Noise',
        },
        unitCode: s.homeB.code,
        body: 'NOTICE-TEXT about the dog',
        open: true,
        sentAt: expect.any(String) as string,
        withdrawnAt: null,
      });
      expect((await notices(s.bob)).map((x) => x.id)).toEqual([noticeId]);
    });

    it('never the complaint: its words, its evidence, its number, its id, its filing time or who filed it', async () => {
      const seen = JSON.stringify([
        (await notice(s.bob, noticeId).expect(200)).body,
        await notices(s.bob),
        await n.list(`/neighbour-notices/${noticeId}/messages`, s.bob),
        await n.notifications(s.c, s.bob.id),
      ]);
      const author = await n.x.asManager(s.c, () =>
        n.x.prisma.tenant.account.findUniqueOrThrow({
          where: { id: s.alice.id },
        }),
      );
      const filed = await n.x.asManager(s.c, () =>
        n.x.prisma.tenant.neighbourComplaint.findUniqueOrThrow({
          where: { id: complaintId },
        }),
      );
      for (const secret of [
        'COMPLAINT-WORDS',
        complaintNumber,
        complaintNumber.replace('NC-', ''),
        complaintId,
        s.alice.id,
        author.fullName!,
        s.homeA.id,
        s.homeA.code,
        filed.createdAt.toISOString(),
      ])
        expect(seen).not.toContain(secret);
    });

    it('the unit is told by a notification that carries the category alone', async () => {
      const rows = (await n.notifications(s.c, s.bob.id)).filter(
        (x) => x.kind === 'neighbour_notice.received',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        targetType: 'neighbour_notice',
        targetId: noticeId,
        params: { categoryKey: 'noise' },
      });
    });

    it('the complaint becomes notice_sent and its author is told that, and nothing of the notice', async () => {
      const detail = await staffDetail(complaintId);
      expect(detail.status).toBe('notice_sent');
      expect(detail.notice).toMatchObject({
        id: noticeId,
        body: 'NOTICE-TEXT about the dog',
        recipientKind: 'household',
        recipients: [{ id: s.bob.id }],
        sentBy: { id: s.handler.id },
      });
      const author = (
        await n
          .http('get', `/neighbour-complaints/${complaintId}`, s.alice.token)
          .expect(200)
      ).body as Record<string, unknown>;
      expect(author.status).toBe('notice_sent');
      const text = JSON.stringify([
        author,
        await n.list(`/neighbour-complaints/${complaintId}/messages`, s.alice),
        await n.notifications(s.c, s.alice.id),
      ]);
      expect(text).not.toContain('NOTICE-TEXT');
      expect(text).not.toContain(noticeId);
      expect(text).not.toContain(s.bob.id);
      expect(
        (await n.notifications(s.c, s.alice.id)).map((x) => x.kind),
      ).toContain('neighbour_complaint.notice_sent');
    });

    it('is audited without its text', async () => {
      const rows = await audit.tenant(s.c.tenantId, {
        action: 'neighbour_complaint.notice_sent',
        targetId: complaintId,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toMatchObject({
        noticeId,
        recipientKind: 'household',
        recipients: 1,
        from: 'under_review',
        to: 'notice_sent',
      });
      expect(JSON.stringify(rows[0])).not.toContain('NOTICE-TEXT');
    });

    it('a complaint has one notice: a second is refused', async () => {
      expect(
        (await n.onComplaint(s.handler, complaintId, 'mediation').expect(204))
          .status,
      ).toBe(204);
      expect(
        (
          await n
            .onComplaint(s.handler, complaintId, 'notice', { body: 'Again' })
            .expect(409)
        ).body,
      ).toMatchObject({ code: 'NEIGHBOUR_NOTICE_ALREADY_SENT' });
    });

    it('a notice nobody was sent, another unit’s and another compound’s are not found', async () => {
      const other = await n.setUp();
      const theirs = await n.noticed(
        other.handler,
        (await n.complain(other.c, other.alice, other.homeB.code)).id,
      );
      for (const [who, id] of [
        [s.alice, noticeId],
        [s.bob, theirs],
        [other.bob, noticeId],
      ] as const) {
        expect((await notice(who, id).expect(404)).body).toMatchObject({
          code: 'NEIGHBOUR_NOTICE_NOT_FOUND',
        });
        await n
          .http('post', `/neighbour-notices/${id}/messages`, who.token, {
            body: 'Hello',
          })
          .expect(404);
      }
      // The staff have no notice routes: a notice is the unit's to read.
      await n.http('get', '/neighbour-notices', s.handler.token).expect(403);
    });
  });

  describe('who it goes to', () => {
    it('in mediation the status stays, and the notice still goes out', async () => {
      const { id } = await n.complain(s.c, s.alice, s.homeB.code);
      await n.onComplaint(s.handler, id, 'review').expect(204);
      await n.onComplaint(s.handler, id, 'mediation').expect(204);
      const told = (await n.notifications(s.c, s.alice.id)).length;
      await n
        .onComplaint(s.handler, id, 'notice', { body: 'While we mediate' })
        .expect(201);
      expect((await staffDetail(id)).status).toBe('mediation');
      // No status change: the author is told nothing.
      expect((await n.notifications(s.c, s.alice.id)).length).toBe(told);
    });

    it('the household’s primary and whoever holds a live household delegation; not the rest of the family', async () => {
      const home = await n.unit(s.c, 'F');
      const primary = await n.owner(s.c, home.id);
      const delegate = await n.family(s.c, home.id, primary);
      const workersOnly = await n.family(s.c, home.id, primary);
      const plain = await n.family(s.c, home.id, primary);
      await n.delegate(s.c, home.id, primary, delegate, ['household']);
      await n.delegate(s.c, home.id, primary, workersOnly, ['workers']);
      const { id } = await n.complain(s.c, s.alice, home.code);
      const noticeId = await n.noticed(s.handler, id);
      expect(
        (await staffDetail(id)).notice!.recipients.map((r) => r.id).sort(),
      ).toEqual([primary.id, delegate.id].sort());
      for (const who of [primary, delegate]) {
        await notice(who, noticeId).expect(200);
        expect(
          (await n.notifications(s.c, who.id)).map((x) => x.kind),
        ).toContain('neighbour_notice.received');
      }
      for (const who of [workersOnly, plain]) {
        await notice(who, noticeId).expect(404);
        expect(await notices(who)).toEqual([]);
        expect(
          await n.notifications(s.c, who.id, 'neighbour_notice.received'),
        ).toEqual([]);
      }
      // Either of the two answers, in the one thread.
      for (const who of [primary, delegate])
        await n
          .http('post', `/neighbour-notices/${noticeId}/messages`, who.token, {
            body: 'We will talk to the children',
          })
          .expect(201);
    });

    it('a rented unit: its tenant, who lives there; never the landlord', async () => {
      const rented = await n.unit(s.c, 'G');
      const landlord = await n.landlord(s.c, rented.id);
      const tenant = await n.tenant(s.c, rented.id);
      const { id } = await n.complain(s.c, s.alice, rented.code);
      const noticeId = await n.noticed(s.handler, id);
      expect((await staffDetail(id)).notice).toMatchObject({
        recipientKind: 'household',
        recipients: [{ id: tenant.id }],
      });
      await notice(tenant, noticeId).expect(200);
      await notice(landlord, noticeId).expect(404);
    });

    it('a unit nobody lives in: its owners', async () => {
      const empty = await n.unit(s.c, 'H');
      const landlord = await n.landlord(s.c, empty.id);
      const { id } = await n.complain(s.c, s.alice, empty.code);
      const noticeId = await n.noticed(s.handler, id);
      expect((await staffDetail(id)).notice).toMatchObject({
        recipientKind: 'owners',
        recipients: [{ id: landlord.id }],
      });
      expect((await notice(landlord, noticeId).expect(200)).body).toMatchObject(
        {
          unitCode: empty.code,
        },
      );
    });

    it('a unit with nobody at all has no one to send it to', async () => {
      const nobody = await n.unit(s.c, 'I');
      const { id } = await n.complain(s.c, s.alice, nobody.code);
      await n.onComplaint(s.handler, id, 'review').expect(204);
      expect(
        (
          await n
            .onComplaint(s.handler, id, 'notice', { body: 'Anyone?' })
            .expect(409)
        ).body,
      ).toMatchObject({ code: 'NEIGHBOUR_NOTICE_NO_RECIPIENT' });
      expect((await staffDetail(id)).status).toBe('under_review');
    });
  });

  describe('who still reads it later', () => {
    it('a household that moved out no longer reads what was sent to it, and the next one never does', async () => {
      const home = await n.unit(s.c, 'J');
      const first = await n.tenant(s.c, home.id);
      const { id } = await n.complain(s.c, s.alice, home.code);
      const noticeId = await n.noticed(s.handler, id);
      await notice(first, noticeId).expect(200);
      await n.moveOut(s.c, home.id, first);
      await notice(first, noticeId).expect(404);
      expect(await notices(first)).toEqual([]);
      await n
        .http('post', `/neighbour-notices/${noticeId}/messages`, first.token, {
          body: 'From afar',
        })
        .expect(404);
      const next = await n.tenant(s.c, home.id);
      await notice(next, noticeId).expect(404);
      expect(await notices(next)).toEqual([]);
      // The staff write on: nobody answers for it in that capacity any more.
      const told = (await n.notifications(s.c, next.id)).length;
      await n
        .http(
          'post',
          `/neighbours/complaints/${id}/unit-messages`,
          s.handler.token,
          {
            body: 'Still there?',
          },
        )
        .expect(201);
      expect((await n.notifications(s.c, next.id)).length).toBe(told);
      expect(
        await n.notifications(s.c, first.id, 'neighbour_notice.replied'),
      ).toEqual([]);
    });

    it('a delegation that ended ends the delegate’s reading; the primary keeps theirs', async () => {
      const home = await n.unit(s.c, 'K');
      const primary = await n.owner(s.c, home.id);
      const delegate = await n.family(s.c, home.id, primary);
      const delegation = await n.delegate(s.c, home.id, primary, delegate);
      const { id } = await n.complain(s.c, s.alice, home.code);
      const noticeId = await n.noticed(s.handler, id);
      await notice(delegate, noticeId).expect(200);
      await n.x.as(s.c, { id: primary.id, type: 'resident' }, () =>
        n.x.prisma.tenant.householdDelegation.update({
          where: { id: delegation.id },
          data: { revokedAt: new Date(), endReason: 'revoked' },
        }),
      );
      await notice(delegate, noticeId).expect(404);
      await notice(primary, noticeId).expect(200);
    });
  });
});
