import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  neighboursHelpers,
  type NeighboursSetUp,
  type Who,
} from '../setup/neighbours';

/**
 * ADR 0042: the staff read no conversation between residents, unless a
 * participant reports it. A report opens a case that shows the staff that
 * one conversation while the case is open; every reading is audited, and
 * closing the case seals it again.
 */
describe('Neighbours — reported conversations', () => {
  let h: HttpHarness;
  let n: ReturnType<typeof neighboursHelpers>;
  let s: NeighboursSetUp;
  let audit: ReturnType<typeof auditReaders>;
  let carol: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    n = neighboursHelpers(h);
    s = await n.setUp();
    audit = auditReaders(h);
    carol = await n.owner(s.c, (await n.unit(s.c, 'C')).id);
    await n.settings(s.c, s.manager, {
      maxOpenPosts: 50,
      maxNewConversationsPerDay: 100,
    });
  }, 180_000);

  afterAll(() => h.close());

  type Report = Record<string, unknown> & { id: string; status: string };
  const report = (who: Who, conversationId: string, body: object = {}) =>
    n.http(
      'post',
      `/neighbour-conversations/${conversationId}/report`,
      who.token,
      {
        reasonCode: 'harassment',
        ...body,
      },
    );
  const reports = (who: Who = s.handler, query = '') =>
    n.list<Report>(`/neighbours/reports${query}`, who);
  const read = (id: string, who: Who = s.handler) =>
    n.http('get', `/neighbours/reports/${id}/messages`, who.token);
  const close = (id: string, reasonCode: string, who: Who = s.handler) =>
    n.http('post', `/neighbours/reports/${id}/close`, who.token, {
      reasonCode,
    });
  /** A conversation with a message from each side. */
  const talked = async (kind = 'lend') => {
    const post = await n.post(s.alice, { kind, body: 'REPORT-POST a ladder' });
    const id = await n.conversation(s.bob, post);
    await n
      .http('post', `/neighbour-conversations/${id}/messages`, s.alice.token, {
        body: 'REPORT-AUTHOR-WORDS go away',
      })
      .expect(201);
    return { post, id };
  };

  it('a participant reports it: the staff get a case with both sides by name, and that conversation', async () => {
    const { post, id } = await talked();
    const res = await report(s.bob, id, {
      reasonCode: 'harassment',
      note: '  REPORT-NOTE they were rude  ',
    }).expect(201);
    expect(Object.keys(res.body as object).sort()).toEqual(['createdAt', 'id']);
    const reportId = (res.body as { id: string }).id;
    const detail = (
      await n
        .http('get', `/neighbours/reports/${reportId}`, s.handler.token)
        .expect(200)
    ).body as Report;
    expect(detail).toMatchObject({
      id: reportId,
      status: 'open',
      reasonCode: 'harassment',
      note: 'REPORT-NOTE they were rude',
      reporter: { id: s.bob.id },
      reporterSide: 'responder',
      conversationId: id,
      author: {
        account: { id: s.alice.id, fullName: expect.any(String) as string },
        unitCode: s.homeA.code,
        building: 'A',
      },
      responder: {
        account: { id: s.bob.id },
        unitCode: s.homeB.code,
        building: 'B',
      },
      post: { id: post, kind: 'lend', body: 'REPORT-POST a ladder' },
      outcome: null,
      closedBy: null,
    });
    const messages = (await read(reportId).expect(200)).body as {
      data: { side: string; body: string; sender: { id: string } }[];
    };
    expect(messages.data.map((m) => [m.side, m.sender.id, m.body])).toEqual([
      ['responder', s.bob.id, 'Is it still available?'],
      ['author', s.alice.id, 'REPORT-AUTHOR-WORDS go away'],
    ]);
    expect(
      (await n.notifications(s.c, s.handler.id)).filter(
        (x) => x.targetId === reportId,
      ),
    ).toMatchObject([
      {
        kind: 'neighbour_conversation.reported',
        targetType: 'neighbour_report',
        params: {},
      },
    ]);
    const rows = await audit.tenant(s.c.tenantId, {
      action: 'neighbour_conversation.reported',
      targetId: id,
    });
    expect(rows[0].metadata).toEqual({ reportId, reasonCode: 'harassment' });
    expect(JSON.stringify(rows)).not.toContain('REPORT-NOTE');
  });

  it('closes the conversation for both, with the same neutral state; the reported side is told nothing', async () => {
    const { id } = await talked();
    const told = (await n.notifications(s.c, s.alice.id)).length;
    await report(s.bob, id).expect(201);
    for (const who of [s.alice, s.bob]) {
      const view = (
        await n
          .http('get', `/neighbour-conversations/${id}`, who.token)
          .expect(200)
      ).body as Record<string, unknown>;
      expect(view.open).toBe(false);
      expect(JSON.stringify(view)).not.toMatch(/report/i);
      expect(
        (
          await n
            .http(
              'post',
              `/neighbour-conversations/${id}/messages`,
              who.token,
              {
                body: 'Hello?',
              },
            )
            .expect(409)
        ).body,
      ).toMatchObject({ code: 'NEIGHBOUR_CONVERSATION_CLOSED' });
    }
    expect((await n.notifications(s.c, s.alice.id)).length).toBe(told);
  });

  it('once per participant; the other side may report it too; nobody else may', async () => {
    const { id } = await talked();
    await report(s.bob, id).expect(201);
    expect((await report(s.bob, id).expect(409)).body).toMatchObject({
      code: 'NEIGHBOUR_REPORT_EXISTS',
    });
    await report(s.alice, id, { reasonCode: 'spam' }).expect(201);
    expect((await report(carol, id).expect(404)).body).toMatchObject({
      code: 'NEIGHBOUR_CONVERSATION_NOT_FOUND',
    });
    for (const who of [s.handler, s.manager]) await report(who, id).expect(403);
    expect(
      (await reports()).filter((r) => r.conversationId === id),
    ).toHaveLength(2);
  });

  it('a reason from the list, and a note of a thousand characters at most', async () => {
    const { id } = await talked();
    const fields = (res: { body: unknown }) =>
      (res.body as { fields: unknown[] }).fields;
    expect(
      fields(await report(s.bob, id, { reasonCode: 'rude' }).expect(400)),
    ).toEqual([
      {
        field: 'reasonCode',
        code: 'INVALID_REASON_CODE',
        params: {
          allowed: ['harassment', 'spam', 'scam', 'inappropriate', 'other'],
        },
      },
    ]);
    expect(
      fields(await report(s.bob, id, { note: 'x'.repeat(1001) }).expect(400)),
    ).toEqual([
      {
        field: 'note',
        code: 'INVALID_LENGTH',
        params: { min: 1, max: 1000 },
      },
    ]);
  });

  it('only that conversation: another one on the same post, and every other, stays out of the staff’s reach', async () => {
    const post = await n.post(s.alice, { kind: 'borrow', body: 'A drill' });
    const reported = await n.conversation(s.bob, post);
    const quiet = await n.conversation(carol, post);
    await n
      .http('post', `/neighbour-conversations/${quiet}/messages`, carol.token, {
        body: 'QUIET-WORDS nobody reported this',
      })
      .expect(201);
    const reportId = (
      (await report(s.bob, reported).expect(201)).body as { id: string }
    ).id;
    const seen = JSON.stringify([
      (await read(reportId).expect(200)).body,
      (await n.http('get', `/neighbours/reports/${reportId}`, s.handler.token))
        .body,
      await reports(),
      await n.list(`/neighbours/posts/${post}/claims`, s.handler),
      (await n.http('get', `/neighbours/posts/${post}`, s.handler.token)).body,
    ]);
    expect(seen).not.toContain('QUIET-WORDS');
    expect(seen).not.toContain(quiet);
    expect(seen).not.toContain(carol.id);
    // The quiet conversation's id is not a case: it opens nothing.
    await n
      .http('get', `/neighbours/reports/${quiet}`, s.handler.token)
      .expect(404);
    await read(quiet).expect(404);
  });

  it('every reading of a reported conversation is audited: who read which case', async () => {
    const { id } = await talked();
    const reportId = (
      (await report(s.bob, id).expect(201)).body as { id: string }
    ).id;
    await read(reportId).expect(200);
    await read(reportId, s.manager).expect(200);
    const rows = await audit.tenant(s.c.tenantId, {
      action: 'neighbour_report.conversation_read',
      targetId: reportId,
    });
    expect(rows.map((r) => r.actorId)).toEqual([s.handler.id, s.manager.id]);
    expect(rows[0].metadata).toEqual({ conversationId: id });
    expect(JSON.stringify(rows)).not.toContain('REPORT-AUTHOR-WORDS');
    // Reading the case's facts is not reading the conversation.
    await n
      .http('get', `/neighbours/reports/${reportId}`, s.handler.token)
      .expect(200);
    expect(
      await audit.tenant(s.c.tenantId, {
        action: 'neighbour_report.conversation_read',
        targetId: reportId,
      }),
    ).toHaveLength(2);
  });

  it('closing the case seals the conversation again; the reporter is told it was looked at, not what was done', async () => {
    const { id } = await talked();
    const reportId = (
      (await report(s.bob, id).expect(201)).body as { id: string }
    ).id;
    await read(reportId).expect(200);
    expect(
      (
        (await close(reportId, 'ignored').expect(400)).body as {
          fields: unknown[];
        }
      ).fields,
    ).toEqual([
      {
        field: 'reasonCode',
        code: 'INVALID_REASON_CODE',
        params: { allowed: ['no_action', 'warned', 'post_removed'] },
      },
    ]);
    await close(reportId, 'warned').expect(204);
    for (const who of [s.handler, s.manager])
      expect((await read(reportId, who).expect(409)).body).toMatchObject({
        code: 'NEIGHBOUR_REPORT_CLOSED',
      });
    expect((await close(reportId, 'no_action').expect(409)).body).toMatchObject(
      {
        code: 'NEIGHBOUR_REPORT_CLOSED',
      },
    );
    expect(
      (
        await n
          .http('get', `/neighbours/reports/${reportId}`, s.handler.token)
          .expect(200)
      ).body,
    ).toMatchObject({
      status: 'closed',
      outcome: 'warned',
      closedBy: { id: s.handler.id },
    });
    expect(
      (await reports(s.handler, '?status=open')).map((r) => r.id),
    ).not.toContain(reportId);
    expect(
      (await reports(s.handler, '?status=closed')).map((r) => r.id),
    ).toContain(reportId);
    const told = (await n.notifications(s.c, s.bob.id)).filter(
      (x) => x.kind === 'neighbour_report.closed' && x.targetId === id,
    );
    expect(told).toMatchObject([
      { targetType: 'neighbour_conversation', params: {} },
    ]);
    expect(JSON.stringify(told)).not.toContain('warned');
    const rows = await audit.tenant(s.c.tenantId, {
      action: 'neighbour_report.closed',
      targetId: reportId,
    });
    expect(rows[0].metadata).toEqual({
      conversationId: id,
      outcome: 'warned',
      postRemoved: 0,
    });
  });

  it('"post removed" takes the post down with the case, and tells its author as any removal does', async () => {
    const { post, id } = await talked('borrow');
    const reportId = (
      (await report(s.bob, id, { reasonCode: 'scam' }).expect(201)).body as {
        id: string;
      }
    ).id;
    await close(reportId, 'post_removed').expect(204);
    expect(
      (
        await n
          .http('get', `/neighbours/posts/${post}`, s.handler.token)
          .expect(200)
      ).body,
    ).toMatchObject({ state: 'closed', closeReason: 'inappropriate' });
    await n.http('get', `/neighbour-posts/${post}`, carol.token).expect(404);
    expect(
      (await n.notifications(s.c, s.alice.id)).filter(
        (x) => x.targetId === post,
      ),
    ).toMatchObject([{ kind: 'neighbour_post.removed' }]);
    expect(
      (
        await audit.tenant(s.c.tenantId, {
          action: 'neighbour_report.closed',
          targetId: reportId,
        })
      )[0].metadata,
    ).toMatchObject({ outcome: 'post_removed', postRemoved: 1 });
  });

  it('a resident reads no case, and another compound’s case is not found', async () => {
    const { id } = await talked();
    const reportId = (
      (await report(s.bob, id).expect(201)).body as { id: string }
    ).id;
    for (const who of [s.alice, s.bob, carol]) {
      await n.http('get', '/neighbours/reports', who.token).expect(403);
      await n
        .http('get', `/neighbours/reports/${reportId}`, who.token)
        .expect(403);
      await read(reportId, who).expect(403);
      await close(reportId, 'no_action', who).expect(403);
    }
    const other = await n.setUp();
    expect(
      (
        await n
          .http('get', `/neighbours/reports/${reportId}`, other.handler.token)
          .expect(404)
      ).body,
    ).toMatchObject({ code: 'NEIGHBOUR_REPORT_NOT_FOUND' });
    await read(reportId, other.handler).expect(404);
    await close(reportId, 'no_action', other.handler).expect(404);
  });
});
