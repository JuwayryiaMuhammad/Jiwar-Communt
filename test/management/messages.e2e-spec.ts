import { fileHelpers } from '../setup/files';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  managementHelpers,
  type ManagementSetUp,
  type Who,
} from '../setup/management';

/**
 * ADR 0039: the conversation of a request — the author and the staff, with
 * photos and documents; the official reply; staff notes that never reach a
 * resident route; and how a message moves the request.
 */
describe('Management requests — the conversation', () => {
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

  type Message = {
    id: string;
    body: string | null;
    senderSide: string;
    official: boolean;
    internal?: boolean;
    sender: { id: string; firstName?: string; fullName?: string };
    attachments: { id: string; contentType: string; url: string | null }[];
    [key: string]: unknown;
  };
  const thread = async (id: string, who: Who, staff = who !== s.owner) =>
    (
      (
        await m
          .http(
            'get',
            `${staff ? '/management/requests' : '/management-requests'}/${id}/messages?limit=100`,
            who.token,
          )
          .expect(200)
      ).body as { data: Message[] }
    ).data;
  const say = (id: string, body: object, who: Who = s.owner) =>
    m.http(
      'post',
      `${who === s.owner ? '/management-requests' : '/management/requests'}/${id}/messages`,
      who.token,
      body,
    );
  const row = (id: string) =>
    m.x.asManager(s.c, () =>
      m.x.prisma.tenant.managementRequest.findUniqueOrThrow({ where: { id } }),
    );

  describe('messages and the status', () => {
    let id: string;

    beforeAll(async () => {
      id = (await m.open(s.c, s.owner, { body: 'First question' })).id;
    });

    it('the request’s words are its first message, by the author', async () => {
      const [first, ...rest] = await thread(id, s.owner);
      expect(rest).toEqual([]);
      expect(first).toMatchObject({
        body: 'First question',
        senderSide: 'resident',
        official: false,
        erased: false,
        attachments: [],
        sender: { id: s.owner.id },
      });
    });

    it('the author’s further message on an open request moves nothing but the activity', async () => {
      const before = await row(id);
      await say(id, { body: '  One more detail  ' }).expect(201);
      const after = await row(id);
      expect(after.status).toBe('open');
      expect(after.firstResponseAt).toBeNull();
      expect(after.lastActivityAt.getTime()).toBeGreaterThan(
        before.lastActivityAt.getTime(),
      );
      expect((await thread(id, s.owner)).map((x) => x.body)).toEqual([
        'First question',
        'One more detail',
      ]);
    });

    it('a staff reply takes it in hand and stops the response clock, once', async () => {
      const posted = await say(
        id,
        { body: 'We are looking into it' },
        handler,
      ).expect(201);
      expect(Object.keys(posted.body as object).sort()).toEqual([
        'createdAt',
        'id',
      ]);
      const first = await row(id);
      expect(first.status).toBe('in_progress');
      expect(first.firstResponseAt).not.toBeNull();
      // The message and the clock carry one time: the database's.
      const [, , reply] = await thread(id, handler);
      expect(new Date(reply.createdAt as string)).toEqual(
        first.firstResponseAt,
      );
      expect(first.lastActivityAt).toEqual(first.firstResponseAt);
      await say(id, { body: 'Still on it' }, s.manager).expect(201);
      const second = await row(id);
      expect(second.firstResponseAt).toEqual(first.firstResponseAt);
      expect(second.status).toBe('in_progress');
    });

    it('the official reply answers it; the flag is the sender’s choice and stays', async () => {
      await say(
        id,
        { body: 'The pool opens at 8', official: true },
        handler,
      ).expect(201);
      const answered = await row(id);
      expect(answered.status).toBe('answered');
      expect(answered.answeredAt).toEqual(answered.lastActivityAt);
      const mine = await thread(id, s.owner);
      expect(mine.map((x) => [x.senderSide, x.official])).toEqual([
        ['resident', false],
        ['resident', false],
        ['staff', false],
        ['staff', false],
        ['staff', true],
      ]);
      // A staff follow-up to the answer is not a new answer.
      await say(id, { body: 'Until 22:00' }, handler).expect(201);
      const still = await row(id);
      expect(still.status).toBe('answered');
      expect(still.answeredAt).toEqual(answered.answeredAt);
    });

    it('the author’s reply to the answer puts it back in hand; a new official reply answers again', async () => {
      await say(id, { body: 'And on Fridays?' }).expect(201);
      expect((await row(id)).status).toBe('in_progress');
      const before = (await row(id)).answeredAt!;
      await say(id, { body: 'From 10', official: true }, s.manager).expect(201);
      const again = await row(id);
      expect(again.status).toBe('answered');
      expect(again.answeredAt!.getTime()).toBeGreaterThan(before.getTime());
    });

    it('the author sees staff by first name; staff see everyone by full name', async () => {
      const mine = await thread(id, s.owner);
      const reply = mine.find((x) => x.senderSide === 'staff')!;
      expect(Object.keys(reply.sender).sort()).toEqual(['firstName', 'id']);
      const theirs = await thread(id, handler);
      expect(Object.keys(theirs[0].sender).sort()).toEqual(['fullName', 'id']);
    });

    it('a body is 1 to 4000 characters once trimmed', async () => {
      for (const body of ['   ', 'x'.repeat(4001)]) {
        const res = await say(id, { body }).expect(400);
        expect(res.body).toMatchObject({
          fields: [
            {
              field: 'body',
              code: 'INVALID_LENGTH',
              params: { min: 1, max: 4000 },
            },
          ],
        });
      }
    });

    it('the same Idempotency-Key posts one message', async () => {
      const post = () =>
        m.http(
          'post',
          `/management-requests/${id}/messages`,
          s.owner.token,
          { body: 'Only once' },
          { 'Idempotency-Key': 'r2-message-once-01' },
        );
      const first = await post().expect(201);
      const second = await post().expect(201);
      expect(second.body).toEqual(first.body);
      expect(
        (await thread(id, s.owner)).filter((x) => x.body === 'Only once'),
      ).toHaveLength(1);
    });

    it('only the author writes on the resident side, and only staff on theirs', async () => {
      const other = await m.setUp();
      await m
        .http(
          'post',
          `/management-requests/${id}/messages`,
          other.owner.token,
          {
            body: 'Not mine',
          },
        )
        .expect(404);
      await m
        .http('post', `/management/requests/${id}/messages`, s.owner.token, {
          body: 'As staff',
        })
        .expect(403);
      await m
        .http('get', `/management/requests/${id}/messages`, s.owner.token)
        .expect(403);
      // A resident cannot make a note or an official reply of their message.
      const res = await say(id, { body: 'Mine', internal: true }).expect(400);
      expect(res.body).toMatchObject({
        fields: [{ field: 'internal', code: 'FIELD_NOT_ALLOWED' }],
      });
      await say(id, { body: 'Mine', official: true }).expect(400);
    });
  });

  describe('staff notes', () => {
    let id: string;
    const NOTE = 'INTERNAL-NOTE resident called twice, be patient';

    beforeAll(async () => {
      id = (await m.open(s.c, s.owner, { body: 'A question' })).id;
    });

    it('a note moves nothing: not the status, the clock or the activity time', async () => {
      const before = await row(id);
      await say(id, { body: NOTE, internal: true }, handler).expect(201);
      const after = await row(id);
      expect(after).toEqual(before);
    });

    it('a note is never official', async () => {
      const res = await say(
        id,
        { body: 'Both', internal: true, official: true },
        handler,
      ).expect(400);
      expect(res.body).toMatchObject({
        fields: [{ field: 'official', code: 'INVALID_VALUE' }],
      });
    });

    it('staff read notes in the conversation, marked', async () => {
      const all = await thread(id, s.manager);
      expect(all.map((x) => [x.body, x.internal])).toEqual([
        ['A question', false],
        [NOTE, true],
      ]);
    });

    it('a note and its attachment are on no resident route, whatever the author asks for', async () => {
      const fileId = await f.ready(
        handler.token,
        'request_attachment',
        'application/pdf',
      );
      const posted = await say(
        id,
        {
          body: `${NOTE} with a file`,
          internal: true,
          attachmentFileIds: [fileId],
        },
        handler,
      ).expect(201);
      const noteId = (posted.body as { id: string }).id;
      const staff = await thread(id, handler);
      const withFile = staff.find((x) => x.id === noteId)!;
      expect(withFile.attachments).toHaveLength(1);
      const attachmentId = withFile.attachments[0].id;

      // Every GET the author has that could carry a message or a file.
      const reads: unknown[] = [];
      for (const path of [
        `/management-requests/${id}`,
        `/management-requests/${id}/messages`,
        `/management-requests/${id}/messages?limit=100`,
        '/management-requests',
        '/management-requests?limit=100',
      ])
        reads.push((await m.http('get', path, s.owner.token).expect(200)).body);
      const seen = JSON.stringify(reads);
      expect(seen).not.toContain('INTERNAL-NOTE');
      expect(seen).not.toContain(noteId);
      expect(seen).not.toContain(attachmentId);
      expect(seen).not.toContain(fileId);
      expect(seen).not.toContain('"internal"');
      // And the thread is exactly the author's own message.
      expect((await thread(id, s.owner)).map((x) => x.body)).toEqual([
        'A question',
      ]);
      // The file is the request's now: its uploader cannot hand it out.
      await m.http('get', `/files/${fileId}`, s.owner.token).expect(404);
    });

    it('paging the author’s thread never lands on a note', async () => {
      await say(id, { body: 'Reply one' }, handler).expect(201);
      await say(
        id,
        { body: `${NOTE} between`, internal: true },
        handler,
      ).expect(201);
      await say(id, { body: 'Reply two' }, handler).expect(201);
      const bodies: (string | null)[] = [];
      let cursor: string | null = null;
      do {
        const res = await m
          .http(
            'get',
            `/management-requests/${id}/messages?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
            s.owner.token,
          )
          .expect(200);
        const page = res.body as { data: Message[]; nextCursor: string | null };
        bodies.push(...page.data.map((x) => x.body));
        cursor = page.nextCursor;
      } while (cursor);
      expect(bodies).toEqual(['A question', 'Reply one', 'Reply two']);
    });

    it('a note is still possible once the request is closed; a reply is not', async () => {
      await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.managementRequest.update({
          where: { id },
          data: {
            status: 'closed',
            closedAt: new Date(),
            closeReason: 'resolved',
            closedBySide: 'staff',
          },
        }),
      );
      await say(id, { body: 'For the file', internal: true }, handler).expect(
        201,
      );
      for (const [who, body] of [
        [handler, { body: 'Too late' }],
        [handler, { body: 'Too late', official: true }],
        [s.owner, { body: 'Too late' }],
      ] as const) {
        const res = await say(id, body, who).expect(409);
        expect(res.body).toMatchObject({
          code: 'MANAGEMENT_REQUEST_INVALID_TRANSITION',
          params: { status: 'closed' },
        });
      }
    });
  });

  describe('attachments', () => {
    let id: string;

    it('a request opens with a photo and a document on its first message', async () => {
      const photo = await f.ready(
        s.owner.token,
        'request_attachment',
        'image/jpeg',
      );
      const pdf = await f.ready(
        s.owner.token,
        'request_attachment',
        'application/pdf',
      );
      id = (
        await m.open(s.c, s.owner, {
          body: 'See the attached bill',
          attachmentFileIds: [photo, pdf],
        })
      ).id;
      for (const who of [s.owner, handler]) {
        const [first] = await thread(id, who);
        expect(first.attachments.map((a) => a.contentType)).toEqual([
          'image/jpeg',
          'application/pdf',
        ]);
        for (const a of first.attachments)
          expect(a.url).toMatch(/^https?:\/\/.+X-Amz-Signature=/);
      }
      // The files left their uploader: the request holds them now.
      const files = await m.x.asManager(s.c, () =>
        m.x.prisma.tenant.storedFile.findMany({
          where: { id: { in: [photo, pdf] } },
          select: { ownerAccountId: true, attachedAt: true },
        }),
      );
      for (const file of files) {
        expect(file.ownerAccountId).toBeNull();
        expect(file.attachedAt).not.toBeNull();
      }
    });

    it('staff attach to a reply, and the author reads it', async () => {
      const pdf = await f.ready(
        handler.token,
        'request_attachment',
        'application/pdf',
      );
      await say(
        id,
        { body: 'The corrected bill', attachmentFileIds: [pdf] },
        handler,
      ).expect(201);
      const mine = await thread(id, s.owner);
      expect(mine[1].attachments.map((a) => a.contentType)).toEqual([
        'application/pdf',
      ]);
    });

    it('only the caller’s own, finalized file of this purpose: anything else is refused and nothing is written', async () => {
      const before = (await thread(id, handler)).length;
      const someoneElses = await f.ready(
        handler.token,
        'request_attachment',
        'image/png',
      );
      const pending = await f.uploaded(
        s.owner.token,
        'request_attachment',
        'image/png',
      );
      const used = await f.ready(
        s.owner.token,
        'request_attachment',
        'image/png',
      );
      await say(id, { body: 'Used once', attachmentFileIds: [used] }).expect(
        201,
      );
      const good = await f.ready(
        s.owner.token,
        'request_attachment',
        'image/png',
      );
      for (const bad of [
        someoneElses,
        pending,
        used,
        '7b0e7a5e-1c1b-4d7f-9a53-1e6d6f3c2a10',
      ]) {
        const res = await say(id, {
          body: 'With a bad file',
          attachmentFileIds: [good, bad],
        }).expect(400);
        expect(res.body).toMatchObject({
          fields: [
            { field: 'attachmentFileIds.1', code: 'FILE_NOT_AVAILABLE' },
          ],
        });
      }
      // The good file of the refused posts is still the author's to use.
      expect((await thread(id, handler)).length).toBe(before + 1);
      await say(id, { body: 'Now alone', attachmentFileIds: [good] }).expect(
        201,
      );
    });

    it('at most five on a message', async () => {
      const ids = Array.from(
        { length: 6 },
        (_, i) => `7b0e7a5e-1c1b-4d7f-9a53-1e6d6f3c2a1${i}`,
      );
      const res = await say(id, {
        body: 'Too many',
        attachmentFileIds: ids,
      }).expect(400);
      expect(res.body).toMatchObject({
        fields: [
          {
            field: 'attachmentFileIds',
            code: 'INVALID_LENGTH',
            params: { min: 0, max: 5 },
          },
        ],
      });
    });

    it('a ticket photo is not a request attachment', async () => {
      const photo = await f.ready(s.owner.token, 'ticket_photo', 'image/png');
      const res = await say(id, {
        body: 'Wrong purpose',
        attachmentFileIds: [photo],
      }).expect(400);
      expect(res.body).toMatchObject({
        fields: [{ field: 'attachmentFileIds.0', code: 'FILE_NOT_AVAILABLE' }],
      });
    });
  });
});
