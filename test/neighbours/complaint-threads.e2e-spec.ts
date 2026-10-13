import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  neighboursHelpers,
  type NeighboursSetUp,
  type Who,
} from '../setup/neighbours';

/**
 * ADR 0042: a complaint's three threads, each private to its side and the
 * staff. The author reads theirs, the unit complained about reads its own
 * (through its notice), the staff read each one by name — and no route
 * returns a message of another thread, nor one of its files.
 */
describe('Neighbour complaints — the three threads', () => {
  let h: HttpHarness;
  let n: ReturnType<typeof neighboursHelpers>;
  let s: NeighboursSetUp;
  let complaintId: string;
  let noticeId: string;

  type Message = {
    id: string;
    body: string | null;
    senderSide: string;
    thread?: string;
    sender: { id: string; firstName?: string; fullName?: string };
    attachments: { id: string; contentType: string; url: string | null }[];
  };

  const staffThread = (
    path: 'messages' | 'unit-messages' | 'notes',
    who: Who = s.handler,
  ) => n.list<Message>(`/neighbours/complaints/${complaintId}/${path}`, who);
  const staffWrites = (
    path: 'messages' | 'unit-messages' | 'notes',
    body: object,
    who: Who = s.handler,
  ) =>
    n.http(
      'post',
      `/neighbours/complaints/${complaintId}/${path}`,
      who.token,
      body,
    );
  const authorThread = () =>
    n.list<Message>(`/neighbour-complaints/${complaintId}/messages`, s.alice);
  const unitThread = (who: Who = s.bob) =>
    n.list<Message>(`/neighbour-notices/${noticeId}/messages`, who);

  beforeAll(async () => {
    h = await createHttpHarness();
    n = neighboursHelpers(h);
    s = await n.setUp();
    complaintId = (
      await n.complain(s.c, s.alice, s.homeB.code, {
        body: 'AUTHOR-WORDS the music is too loud',
        attachmentFileIds: [
          await n.file(s.alice, 'complaint_evidence', 'image/png'),
          await n.file(s.alice, 'complaint_evidence', 'application/pdf'),
        ],
      })
    ).id;
  }, 180_000);

  afterAll(() => h.close());

  it('the complaint’s words and its evidence, photos and a PDF, are its first message', async () => {
    const [first] = await authorThread();
    expect(first.body).toBe('AUTHOR-WORDS the music is too loud');
    expect(first.attachments.map((a) => a.contentType).sort()).toEqual([
      'application/pdf',
      'image/png',
    ]);
    for (const a of first.attachments) {
      const got = await fetch(a.url!);
      expect(got.status).toBe(200);
    }
  });

  it('evidence is the caller’s own finalized file of that purpose, five at most, and never a video', async () => {
    const post = (attachmentFileIds: string[], who: Who = s.alice) =>
      n.http(
        'post',
        `/neighbour-complaints/${complaintId}/messages`,
        who.token,
        { body: 'More', attachmentFileIds },
      );
    const bobs = await n.file(s.bob, 'complaint_evidence');
    const fields = (res: { body: unknown }) =>
      (res.body as { fields: unknown[] }).fields;
    expect(fields(await post([bobs]).expect(400))).toEqual([
      { field: 'attachmentFileIds.0', code: 'FILE_NOT_AVAILABLE' },
    ]);
    const photo = await n.file(s.alice, 'neighbour_post_photo');
    expect(fields(await post([photo]).expect(400))).toEqual([
      { field: 'attachmentFileIds.0', code: 'FILE_NOT_AVAILABLE' },
    ]);
    const six = [];
    for (let i = 0; i < 6; i++)
      six.push(await n.file(s.alice, 'complaint_evidence'));
    expect(fields(await post(six).expect(400))).toEqual([
      {
        field: 'attachmentFileIds',
        code: 'INVALID_LENGTH',
        params: { min: 0, max: 5 },
      },
    ]);
    // No purpose of the domain takes a video: the upload is refused.
    const video = await h
      .http()
      .post('/api/v1/files/uploads')
      .set('Authorization', `Bearer ${s.alice.token}`)
      .send({
        purpose: 'complaint_evidence',
        contentType: 'video/mp4',
        size: 10,
      });
    expect(video.status).toBe(400);
  });

  it('the staff and the author talk in the author’s thread; each is told of the other’s message', async () => {
    await staffWrites('messages', {
      body: 'STAFF-TO-AUTHOR we are on it',
    }).expect(201);
    await n
      .http(
        'post',
        `/neighbour-complaints/${complaintId}/messages`,
        s.alice.token,
        {
          body: 'AUTHOR-REPLY thank you',
        },
      )
      .expect(201);
    const thread = await authorThread();
    expect(thread.map((m) => [m.senderSide, m.body])).toEqual([
      ['resident', 'AUTHOR-WORDS the music is too loud'],
      ['staff', 'STAFF-TO-AUTHOR we are on it'],
      ['resident', 'AUTHOR-REPLY thank you'],
    ]);
    // The author sees the staff by first name; the staff see her in full.
    expect(thread[1].sender).toEqual({
      id: s.handler.id,
      firstName: expect.any(String) as string,
    });
    expect((await staffThread('messages'))[0].sender).toMatchObject({
      id: s.alice.id,
      fullName: expect.any(String) as string,
    });
    const told = (who: Who) =>
      n
        .notifications(s.c, who.id)
        .then((rows) =>
          rows.filter((x) => x.targetId === complaintId).map((x) => x.kind),
        );
    expect(await told(s.alice)).toEqual(['neighbour_complaint.replied']);
    expect(await told(s.handler)).toContain(
      'neighbour_complaint.author_replied',
    );
  });

  it('a staff note is the staff’s alone: on no resident route, and it tells nobody', async () => {
    const before = (await n.notifications(s.c, s.alice.id)).length;
    await staffWrites('notes', {
      body: 'STAFF-NOTE third complaint this month',
      attachmentFileIds: [await n.file(s.handler, 'complaint_evidence')],
    }).expect(201);
    const notes = await staffThread('notes');
    expect(notes).toMatchObject([
      { thread: 'internal', body: 'STAFF-NOTE third complaint this month' },
    ]);
    const noteFile = notes[0].attachments[0].id;
    const author = JSON.stringify(await authorThread());
    expect(author).not.toContain('STAFF-NOTE');
    expect(author).not.toContain(noteFile);
    expect((await n.notifications(s.c, s.alice.id)).length).toBe(before);
    // A resident view has no field that could say a note exists.
    for (const m of await authorThread()) {
      expect(m).not.toHaveProperty('thread');
      expect(m).not.toHaveProperty('internal');
    }
  });

  it('the unit’s thread does not exist before its notice: nobody writes in it', async () => {
    expect(
      (await staffWrites('unit-messages', { body: 'Hello' }).expect(409)).body,
    ).toMatchObject({ code: 'NEIGHBOUR_NOTICE_NOT_SENT' });
    expect(await staffThread('unit-messages')).toEqual([]);
  });

  describe('once the unit has its notice', () => {
    beforeAll(async () => {
      noticeId = await n.noticed(
        s.handler,
        complaintId,
        'NOTICE-TEXT keep it down',
      );
      await n
        .http('post', `/neighbour-notices/${noticeId}/messages`, s.bob.token, {
          body: 'UNIT-REPLY it was one party',
          attachmentFileIds: [await n.file(s.bob, 'complaint_evidence')],
        })
        .expect(201);
      await staffWrites('unit-messages', {
        body: 'STAFF-TO-UNIT thank you for answering',
      }).expect(201);
    });

    it('the unit and the staff talk in the unit’s thread', async () => {
      expect((await unitThread()).map((m) => [m.senderSide, m.body])).toEqual([
        ['resident', 'UNIT-REPLY it was one party'],
        ['staff', 'STAFF-TO-UNIT thank you for answering'],
      ]);
      expect((await staffThread('unit-messages')).map((m) => m.thread)).toEqual(
        ['target', 'target'],
      );
    });

    it('each thread holds only its own messages, on every route that reads one', async () => {
      const words = {
        author: ['AUTHOR-WORDS', 'STAFF-TO-AUTHOR', 'AUTHOR-REPLY'],
        unit: ['UNIT-REPLY', 'STAFF-TO-UNIT'],
        notes: ['STAFF-NOTE'],
      };
      const read = {
        author: JSON.stringify(await authorThread()),
        unit: JSON.stringify(await unitThread()),
        staffAuthor: JSON.stringify(await staffThread('messages')),
        staffUnit: JSON.stringify(await staffThread('unit-messages')),
        staffNotes: JSON.stringify(await staffThread('notes')),
      };
      const holds = (text: string, list: string[]) =>
        list.filter((w) => text.includes(w));
      expect(holds(read.author, words.author)).toEqual(words.author);
      expect(holds(read.author, [...words.unit, ...words.notes])).toEqual([]);
      expect(holds(read.unit, words.unit)).toEqual(words.unit);
      expect(holds(read.unit, [...words.author, ...words.notes])).toEqual([]);
      expect(holds(read.staffAuthor, words.author)).toEqual(words.author);
      expect(holds(read.staffAuthor, [...words.unit, ...words.notes])).toEqual(
        [],
      );
      expect(holds(read.staffUnit, words.unit)).toEqual(words.unit);
      expect(holds(read.staffUnit, [...words.author, ...words.notes])).toEqual(
        [],
      );
      expect(holds(read.staffNotes, words.notes)).toEqual(words.notes);
      expect(holds(read.staffNotes, [...words.author, ...words.unit])).toEqual(
        [],
      );
    });

    it('no file crosses: the evidence never reaches the unit, nor the unit’s file the author', async () => {
      const ids = (list: Message[]) =>
        list.flatMap((m) => m.attachments.map((a) => a.id));
      const evidence = ids(await authorThread());
      const unitFiles = ids(await unitThread());
      expect(evidence.length).toBeGreaterThan(0);
      expect(unitFiles).toHaveLength(1);
      expect(evidence.filter((id) => unitFiles.includes(id))).toEqual([]);
      expect(JSON.stringify(await unitThread())).not.toContain(evidence[0]);
      expect(JSON.stringify(await authorThread())).not.toContain(unitFiles[0]);
    });

    it('the author is told nothing of the unit’s thread, and their complaint does not stir', async () => {
      const before = (
        await n
          .http('get', `/neighbour-complaints/${complaintId}`, s.alice.token)
          .expect(200)
      ).body as { lastActivityAt: string };
      const told = (await n.notifications(s.c, s.alice.id)).length;
      await n
        .http('post', `/neighbour-notices/${noticeId}/messages`, s.bob.token, {
          body: 'UNIT-REPLY again',
        })
        .expect(201);
      await staffWrites('unit-messages', {
        body: 'STAFF-TO-UNIT noted',
      }).expect(201);
      await staffWrites('notes', { body: 'STAFF-NOTE again' }).expect(201);
      const after = (
        await n
          .http('get', `/neighbour-complaints/${complaintId}`, s.alice.token)
          .expect(200)
      ).body as { lastActivityAt: string };
      expect(after.lastActivityAt).toBe(before.lastActivityAt);
      expect((await n.notifications(s.c, s.alice.id)).length).toBe(told);
      // The staff are told the unit answered; the unit that the staff wrote.
      expect(
        (await n.notifications(s.c, s.handler.id)).map((x) => x.kind),
      ).toContain('neighbour_notice.unit_replied');
      expect((await n.notifications(s.c, s.bob.id)).map((x) => x.kind)).toEqual(
        expect.arrayContaining([
          'neighbour_notice.received',
          'neighbour_notice.replied',
        ]),
      );
    });

    it('the author cannot reach the unit’s thread by the notice, nor the unit the author’s by the complaint', async () => {
      await n
        .http('get', `/neighbour-notices/${noticeId}/messages`, s.alice.token)
        .expect(404);
      await n
        .http('get', `/neighbour-notices/${noticeId}`, s.alice.token)
        .expect(404);
      await n
        .http(
          'get',
          `/neighbour-complaints/${complaintId}/messages`,
          s.bob.token,
        )
        .expect(404);
      await n
        .http('get', `/neighbour-notices/${complaintId}`, s.bob.token)
        .expect(404);
    });

    it('a closed complaint takes no message from either side, but a staff note', async () => {
      await n
        .onComplaint(s.handler, complaintId, 'resolve', {
          reasonCode: 'complied',
        })
        .expect(204);
      for (const res of [
        await n.http(
          'post',
          `/neighbour-complaints/${complaintId}/messages`,
          s.alice.token,
          { body: 'Late' },
        ),
        await n.http(
          'post',
          `/neighbour-notices/${noticeId}/messages`,
          s.bob.token,
          { body: 'Late' },
        ),
        await staffWrites('messages', { body: 'Late' }),
        await staffWrites('unit-messages', { body: 'Late' }),
      ]) {
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          code: 'NEIGHBOUR_COMPLAINT_INVALID_TRANSITION',
          params: { status: 'resolved' },
        });
      }
      await staffWrites('notes', { body: 'STAFF-NOTE closing remark' }).expect(
        201,
      );
    });
  });
});
