import { AccountsService } from '../../src/core/accounts/accounts.service';
import { eraseNow } from '../setup/erasure';
import { buildExports, readArchive, stepUp } from '../setup/exports';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  neighboursHelpers,
  type NeighboursSetUp,
  type Who,
} from '../setup/neighbours';

/**
 * ADR 0042 with ADR 0023 and 0036: what a personal-data export holds of a
 * person's neighbours data (their complaints, the notices they received,
 * their posts, claims, blocks and their side of each conversation — never
 * another person's identity), what an erasure takes away (their words and
 * photos) and leaves (the rows, the staff's text, a complaint's evidence),
 * and what leaving the compound ends.
 */
describe('Neighbours — export, erasure and leaving', () => {
  let h: HttpHarness;
  let n: ReturnType<typeof neighboursHelpers>;
  let s: NeighboursSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    n = neighboursHelpers(h);
    s = await n.setUp();
    await n.settings(s.c, s.manager, {
      maxOpenComplaints: 50,
      maxOpenPosts: 50,
      maxNewConversationsPerDay: 100,
    });
  }, 180_000);

  afterAll(() => h.close());

  /**
   * A second owner of a unit: not its primary, so they can be erased. With
   * the email an export's step-up needs.
   */
  async function resident(unitId: string) {
    const p = await n.x.resident(s.c, [unitId]);
    return { ...p, ...(await n.who(s.c, p.id, 'resident')) };
  }

  async function exportOf(p: Who & { email: string }) {
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
    return readArchive((dl.body as { url: string }).url);
  }
  const say = (who: Who, path: string, body: string) =>
    n.http('post', path, who.token, { body }).expect(201);

  describe('the personal-data export', () => {
    it('holds the account’s own complaints, notices, posts, claims, blocks and its side of each conversation — and nobody else’s identity', async () => {
      const home = await n.unit(s.c, 'E');
      const primary = await n.owner(s.c, home.id);
      const p = await resident(home.id);
      const other = await n.owner(s.c, (await n.unit(s.c, 'F')).id);

      // A complaint of theirs, with every thread written in.
      const mine = await n.complain(s.c, p, s.homeB.code, {
        body: 'EXPORT-MY-COMPLAINT',
        attachmentFileIds: [await n.file(p, 'complaint_evidence')],
      });
      const theirNotice = await n.noticed(
        s.handler,
        mine.id,
        'EXPORT-NOTICE-TO-BOB',
      );
      await say(
        s.handler,
        `/neighbours/complaints/${mine.id}/messages`,
        'EXPORT-STAFF-TO-ME',
      );
      await say(
        s.handler,
        `/neighbours/complaints/${mine.id}/notes`,
        'EXPORT-STAFF-NOTE',
      );
      await say(
        s.bob,
        `/neighbour-notices/${theirNotice}/messages`,
        'EXPORT-BOB-REPLY',
      );
      // Someone else's complaint, against their home: they are not its primary.
      const against = await n.complain(s.c, other, home.code, {
        body: 'EXPORT-COMPLAINT-AGAINST-HOME',
      });
      await n.noticed(s.handler, against.id, 'EXPORT-NOTICE-TO-PRIMARY');

      // A notice they do receive: the primary delegated the household to...
      // nobody; so make them the recipient of one as an owner of an empty unit.
      const empty = await n.unit(s.c, 'G');
      const owned = await n.x.asManager(s.c, () =>
        n.x.residents.addOccupancy(p.id, {
          unitId: empty.id,
          occupancyType: 'owner',
          resides: false,
        }),
      );
      expect(owned).toBeDefined();
      const aboutEmpty = await n.complain(s.c, other, empty.code, {
        body: 'EXPORT-COMPLAINT-ABOUT-EMPTY',
      });
      const myNotice = await n.noticed(
        s.handler,
        aboutEmpty.id,
        'EXPORT-NOTICE-TO-ME',
      );
      await say(
        p,
        `/neighbour-notices/${myNotice}/messages`,
        'EXPORT-MY-NOTICE-REPLY',
      );
      await say(
        s.handler,
        `/neighbours/complaints/${aboutEmpty.id}/unit-messages`,
        'EXPORT-STAFF-TO-MY-UNIT',
      );

      // Posts, a claim, and both sides of masked contact.
      const myPost = await n.post(p, {
        kind: 'lend',
        body: 'EXPORT-MY-POST',
        place: 'EXPORT-MY-PLACE',
        photoFileIds: [await n.file(p, 'neighbour_post_photo')],
      });
      const othersPost = await n.post(other, { body: 'EXPORT-OTHER-POST' });
      await n.claim(p, othersPost, 'EXPORT-MY-CLAIM-NOTE');
      const withOther = (
        (await n.contact(other, myPost, 'EXPORT-OTHER-WORDS').expect(201))
          .body as {
          id: string;
        }
      ).id;
      await say(
        p,
        `/neighbour-conversations/${withOther}/messages`,
        'EXPORT-MY-WORDS',
      );
      for (const who of [p, other])
        await n
          .http(
            'post',
            `/neighbour-conversations/${withOther}/reveal`,
            who.token,
          )
          .expect(200);
      const blocked = await n.conversation(
        p,
        await n.post(s.alice, { body: 'A hat' }),
      );
      await n
        .http('post', `/neighbour-conversations/${blocked}/block`, p.token)
        .expect(204);

      const archive = await exportOf(p);
      const section = archive.names.filter((x) => x.startsWith('neighbours/'));
      expect(section.sort()).toEqual(
        [
          'neighbours/blocks.json',
          'neighbours/claims.json',
          `neighbours/complaints/${mine.number}.json`,
          `neighbours/conversations/${blocked}.json`,
          `neighbours/conversations/${withOther}.json`,
          `neighbours/notices/${myNotice}.json`,
          'neighbours/posts.json',
        ].sort(),
      );
      const text = section.map(archive.text).join('\n');
      // Their own words, and the management's words to them.
      for (const own of [
        'EXPORT-MY-COMPLAINT',
        'EXPORT-STAFF-TO-ME',
        'EXPORT-NOTICE-TO-ME',
        'EXPORT-MY-NOTICE-REPLY',
        'EXPORT-STAFF-TO-MY-UNIT',
        'EXPORT-MY-POST',
        'EXPORT-MY-PLACE',
        'EXPORT-MY-CLAIM-NOTE',
        'EXPORT-MY-WORDS',
      ])
        expect(text).toContain(own);
      // Nothing of anyone else's, of the staff's own, or of the other thread.
      for (const notTheirs of [
        'EXPORT-STAFF-NOTE',
        'EXPORT-NOTICE-TO-BOB',
        'EXPORT-BOB-REPLY',
        'EXPORT-COMPLAINT-AGAINST-HOME',
        'EXPORT-NOTICE-TO-PRIMARY',
        'EXPORT-COMPLAINT-ABOUT-EMPTY',
        'EXPORT-OTHER-POST',
        'EXPORT-OTHER-WORDS',
      ])
        expect(text).not.toContain(notTheirs);
      // No other person's identity: not an id, not a name, not even the
      // first name both agreed to show.
      const people = await n.x.asManager(s.c, () =>
        n.x.prisma.tenant.account.findMany({
          where: {
            id: {
              in: [other.id, s.alice.id, s.bob.id, primary.id, s.handler.id],
            },
          },
          select: { id: true, fullName: true },
        }),
      );
      for (const person of people) {
        expect(text).not.toContain(person.id);
        expect(text).not.toContain(person.fullName!);
      }
      expect(text).not.toContain('"firstName"');
      expect(text).not.toContain('"sender"');
      // The other side of a conversation is a building and a count.
      expect(
        JSON.parse(archive.text(`neighbours/conversations/${withOther}.json`)),
      ).toMatchObject({
        side: 'author',
        namesRevealed: true,
        other: { building: 'F' },
        messages: [{ mine: true, body: 'EXPORT-MY-WORDS' }],
        otherSideMessageCount: 1,
      });
      // Files are records: counted, never linked.
      expect(text).not.toMatch(/https?:\/\//);
      expect(
        JSON.parse(archive.text(`neighbours/complaints/${mine.number}.json`)),
      ).toMatchObject({
        number: mine.number,
        targetUnitCode: s.homeB.code,
        messages: [
          { mine: true, body: 'EXPORT-MY-COMPLAINT', attachmentCount: 1 },
          { mine: false, senderSide: 'staff', body: 'EXPORT-STAFF-TO-ME' },
        ],
      });
      expect(JSON.parse(archive.text('neighbours/posts.json'))).toMatchObject([
        { id: myPost, body: 'EXPORT-MY-POST', photoCount: 1 },
      ]);
      expect(JSON.parse(archive.text('neighbours/blocks.json'))).toMatchObject([
        { building: 'A' },
      ]);
    });
  });

  describe('an erasure', () => {
    it('clears the person’s words and photos and closes what was theirs; the rows, the staff’s text and the evidence stay', async () => {
      const home = await n.unit(s.c, 'H');
      await n.owner(s.c, home.id);
      const p = await resident(home.id);
      const other = await n.owner(s.c, (await n.unit(s.c, 'I')).id);

      const complaint = await n.complain(s.c, p, s.homeB.code, {
        body: 'ERASE-COMPLAINT',
        attachmentFileIds: [await n.file(p, 'complaint_evidence')],
      });
      await n.noticed(s.handler, complaint.id, 'ERASE-KEPT-NOTICE');
      await say(
        s.handler,
        `/neighbours/complaints/${complaint.id}/messages`,
        'ERASE-KEPT-STAFF-REPLY',
      );
      await say(
        p,
        `/neighbour-complaints/${complaint.id}/messages`,
        'ERASE-MY-REPLY',
      );

      const photoFileId = await n.file(p, 'neighbour_post_photo');
      const post = await n.post(p, {
        body: 'ERASE-POST',
        place: 'ERASE-PLACE',
        photoFileIds: [photoFileId],
      });
      const waiting = await n.claim(other, post, 'ERASE-KEPT-OTHER-CLAIM');
      const claimed = await n.claim(
        p,
        await n.post(other, { body: 'ERASE-KEPT-OTHER-POST' }),
        'ERASE-MY-CLAIM-NOTE',
      );
      const conversation = (
        (await n.contact(other, post, 'ERASE-KEPT-OTHER-WORDS').expect(201))
          .body as {
          id: string;
        }
      ).id;
      await say(
        p,
        `/neighbour-conversations/${conversation}/messages`,
        'ERASE-MY-WORDS',
      );
      const reported = await n.conversation(
        p,
        await n.post(other, { kind: 'lend', body: 'A ladder' }),
      );
      await n
        .http('post', `/neighbour-conversations/${reported}/report`, p.token, {
          reasonCode: 'spam',
          note: 'ERASE-MY-REPORT-NOTE',
        })
        .expect(201);
      const blockedIn = await n.conversation(
        p,
        await n.post(s.alice, { body: 'A hat' }),
      );
      await n
        .http('post', `/neighbour-conversations/${blockedIn}/block`, p.token)
        .expect(204);
      const blockedBy = await n.conversation(
        s.bob,
        await n.post(p, { kind: 'lend', body: 'ERASE-POST-TWO' }),
      );
      await n
        .http(
          'post',
          `/neighbour-conversations/${blockedBy}/block`,
          s.bob.token,
        )
        .expect(204);

      await eraseNow(h, s.c, p.id);

      const db = await n.x.asManager(s.c, async () => ({
        complaint: await n.x.prisma.tenant.neighbourComplaint.findUniqueOrThrow(
          {
            where: { id: complaint.id },
          },
        ),
        messages: await n.x.prisma.tenant.neighbourComplaintMessage.findMany({
          where: { complaintId: complaint.id },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        evidence: await n.x.prisma.tenant.neighbourComplaintAttachment.findMany(
          {
            where: { complaintId: complaint.id },
            include: { file: true },
          },
        ),
        notice:
          await n.x.prisma.tenant.neighbourComplaintNotice.findFirstOrThrow({
            where: { complaintId: complaint.id },
          }),
        posts: await n.x.prisma.tenant.neighbourPost.findMany({
          where: { authorId: p.id },
        }),
        photos: await n.x.prisma.tenant.neighbourPostPhoto.findMany({
          where: { postId: post },
          include: { file: true },
        }),
        claims: await n.x.prisma.tenant.neighbourItemClaim.findMany({
          where: { id: { in: [waiting, claimed] } },
        }),
        conversations: await n.x.prisma.tenant.neighbourConversation.findMany({
          where: { OR: [{ authorId: p.id }, { responderId: p.id }] },
        }),
        words: await n.x.prisma.tenant.neighbourConversationMessage.findMany({
          where: { conversationId: conversation },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        reports: await n.x.prisma.tenant.neighbourConversationReport.findMany({
          where: { reporterId: p.id },
        }),
        blocks: await n.x.prisma.tenant.neighbourBlock.count({
          where: { OR: [{ blockerId: p.id }, { blockedId: p.id }] },
        }),
      }));
      // Their messages: the words gone, the rows kept; the staff's kept whole.
      expect(
        db.messages.map((m) => [m.senderSide, m.body, m.erasedAt !== null]),
      ).toEqual([
        ['resident', null, true],
        ['staff', 'ERASE-KEPT-STAFF-REPLY', false],
        ['resident', null, true],
      ]);
      // The complaint, its status, its notice and its evidence stay.
      expect(db.complaint.status).toBe('notice_sent');
      expect(db.notice.body).toBe('ERASE-KEPT-NOTICE');
      expect(db.evidence).toHaveLength(1);
      expect(db.evidence[0].file.deletedAt).toBeNull();
      // Their posts: closed, without words or place, their photos deleted.
      expect(db.posts).toHaveLength(2);
      for (const row of db.posts)
        expect(row).toMatchObject({
          status: 'closed',
          closeReason: 'author_erased',
          body: null,
          place: null,
        });
      // Their photo: its row went with its file, and its file's row is gone
      // too, so the files sweep has nothing left to retry.
      expect(db.photos).toEqual([]);
      expect(
        await n.x.asManager(s.c, () =>
          n.x.prisma.tenant.storedFile.count({
            where: { id: photoFileId },
          }),
        ),
      ).toBe(0);
      expect(
        await n.x.asManager(s.c, () =>
          n.x.prisma.tenant.storedFile.count({
            where: { deletedAt: { not: null } },
          }),
        ),
      ).toBe(0);
      // The claim on their post is declined; their own is taken back, noteless.
      expect(
        Object.fromEntries(db.claims.map((c) => [c.id, [c.status, c.note]])),
      ).toEqual({
        [waiting]: ['declined', 'ERASE-KEPT-OTHER-CLAIM'],
        [claimed]: ['withdrawn', null],
      });
      // Every conversation of theirs is closed; their words gone, the other's kept.
      expect(db.conversations.length).toBeGreaterThanOrEqual(4);
      for (const c of db.conversations) expect(c.closedAt).not.toBeNull();
      expect(db.words.map((m) => m.body)).toEqual([
        'ERASE-KEPT-OTHER-WORDS',
        null,
      ]);
      expect(db.reports).toMatchObject([{ note: null, reasonCode: 'spam' }]);
      expect(db.blocks).toBe(0);

      // What others and the staff read now.
      const staffThread = await n.list<{
        body: string | null;
        erased: boolean;
        sender: object;
      }>(`/neighbours/complaints/${complaint.id}/messages`, s.handler);
      expect(staffThread[0]).toMatchObject({
        body: null,
        erased: true,
        sender: { id: p.id, erased: true },
      });
      const detail = JSON.stringify(
        (
          await n
            .http(
              'get',
              `/neighbours/complaints/${complaint.id}`,
              s.handler.token,
            )
            .expect(200)
        ).body,
      );
      expect(detail).not.toContain(p.fullName);
      const others = (
        await n
          .http('get', `/neighbour-conversations/${conversation}`, other.token)
          .expect(200)
      ).body as { open: boolean };
      expect(others.open).toBe(false);
      const everything = JSON.stringify([
        staffThread,
        await n.list(
          `/neighbour-conversations/${conversation}/messages`,
          other,
        ),
        await n.list('/neighbours/posts?state=closed', s.handler),
        await n.list(`/neighbours/posts/${post}/claims`, s.handler),
        await n.list('/neighbours/reports', s.handler),
      ]);
      for (const gone of [
        'ERASE-COMPLAINT',
        'ERASE-MY-REPLY',
        'ERASE-POST',
        'ERASE-PLACE',
        'ERASE-MY-CLAIM-NOTE',
        'ERASE-MY-WORDS',
        'ERASE-MY-REPORT-NOTE',
      ])
        expect(everything).not.toContain(gone);
      // The post the other blocked them on is theirs no more to be hidden from.
      await n.http('get', '/neighbour-posts', s.bob.token).expect(200);
    });

    it('a staff member’s erasure leaves the notice they sent and the post they made as the management', async () => {
      // Another account of the handlers' role.
      const temp = await n.staff(s.c);
      const { id } = await n.complain(s.c, s.alice, s.homeB.code);
      await n.noticed(temp, id, 'ERASE-STAFF-NOTICE');
      const post = await n.staffPost(temp, { body: 'ERASE-STAFF-POST' });
      // A staff account is erased only once it no longer works here.
      await n.x.asManager(s.c, () =>
        h.moduleRef
          .get(AccountsService)
          .updateStatus(temp.id, { status: 'inactive' }),
      );
      await eraseNow(h, s.c, temp.id);
      const rows = await n.x.asManager(s.c, async () => ({
        notice:
          await n.x.prisma.tenant.neighbourComplaintNotice.findFirstOrThrow({
            where: { complaintId: id },
          }),
        post: await n.x.prisma.tenant.neighbourPost.findUniqueOrThrow({
          where: { id: post },
        }),
      }));
      expect(rows.notice.body).toBe('ERASE-STAFF-NOTICE');
      expect(rows.post).toMatchObject({
        body: 'ERASE-STAFF-POST',
        status: 'open',
      });
    });
  });

  describe('leaving the compound', () => {
    it('someone with no place left has no post on a board and no open conversation; their complaint stays with the staff', async () => {
      const home = await n.unit(s.c, 'J');
      const leaver = await n.tenant(s.c, home.id);
      const { id } = await n.complain(s.c, leaver, s.homeB.code);
      const post = await n.post(leaver, { kind: 'lend', body: 'A sofa' });
      const conversation = await n.conversation(s.alice, post);
      await n.moveOut(s.c, home.id, leaver);

      expect(
        (await n.list<{ id: string }>('/neighbour-posts', s.alice)).map(
          (p) => p.id,
        ),
      ).not.toContain(post);
      expect(
        (
          await n
            .http('get', `/neighbours/posts/${post}`, s.handler.token)
            .expect(200)
        ).body,
      ).toMatchObject({ state: 'closed', closeReason: 'author_left' });
      expect(
        (
          await n
            .http(
              'get',
              `/neighbour-conversations/${conversation}`,
              s.alice.token,
            )
            .expect(200)
        ).body,
      ).toMatchObject({ open: false });
      expect(
        (
          await n
            .http('get', `/neighbours/complaints/${id}`, s.handler.token)
            .expect(200)
        ).body,
      ).toMatchObject({ status: 'submitted', open: true });
      // No longer a neighbour: nothing new from them.
      await n.complainRaw(s.c, leaver, s.homeB.code).expect(403);
      await n
        .http('post', '/neighbour-posts', leaver.token, {
          kind: 'lost',
          body: 'A key',
        })
        .expect(403);
    });

    it('someone who still has another place keeps their posts', async () => {
      const one = await n.unit(s.c, 'K');
      const two = await n.unit(s.c, 'L');
      const p = await n.x.resident(s.c, [one.id, two.id], 'tenant');
      const who = await n.who(s.c, p.id, 'resident');
      const post = await n.post(who, {
        kind: 'lend',
        body: 'A chair',
        unitId: two.id,
      });
      await n.moveOut(s.c, one.id, who);
      expect(
        (
          await n
            .http('get', `/neighbours/posts/${post}`, s.handler.token)
            .expect(200)
        ).body,
      ).toMatchObject({ state: 'open' });
    });
  });
});
