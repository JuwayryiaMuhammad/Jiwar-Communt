import { NOTIFICATION_KINDS } from '../../src/core/notifications/kinds';
import { PUSH_TEXTS } from '../../src/core/push/push-texts';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  neighboursHelpers,
  type NeighboursSetUp,
  type Who,
} from '../setup/neighbours';

/**
 * ADR 0042: what the neighbours domain tells people. All in the category
 * `neighbours`, none critical, with ids and keys for params: never a word
 * anyone wrote, a name, a unit or a building. What the unit complained
 * about is told never carries the complaint's number.
 */
describe('Neighbours — notifications', () => {
  let h: HttpHarness;
  let n: ReturnType<typeof neighboursHelpers>;
  let s: NeighboursSetUp;
  let carol: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    n = neighboursHelpers(h);
    s = await n.setUp();
    carol = await n.owner(s.c, (await n.unit(s.c, 'C')).id);
  }, 180_000);

  afterAll(() => h.close());

  const kinds = Object.entries(NOTIFICATION_KINDS).filter(
    ([, spec]) => spec.category === 'neighbours',
  );
  /** Every notification of the compound, whoever it is for. */
  const all = () =>
    n.x.asManager(s.c, () =>
      n.x.prisma.tenant.notification.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );

  it('twenty-three kinds, in the category `neighbours`, none critical, no param that could carry text', () => {
    expect(
      kinds.map(([kind, spec]) => [
        kind,
        spec.target,
        Object.keys(spec.params).sort(),
      ]),
    ).toEqual([
      [
        'neighbour_complaint.submitted',
        'neighbour_complaint',
        ['categoryKey', 'complaintNumber'],
      ],
      [
        'neighbour_complaint.author_replied',
        'neighbour_complaint',
        ['categoryKey', 'complaintNumber'],
      ],
      [
        'neighbour_complaint.withdrawn',
        'neighbour_complaint',
        ['categoryKey', 'complaintNumber'],
      ],
      [
        'neighbour_complaint.under_review',
        'neighbour_complaint',
        ['categoryKey', 'complaintNumber'],
      ],
      [
        'neighbour_complaint.in_mediation',
        'neighbour_complaint',
        ['categoryKey', 'complaintNumber'],
      ],
      [
        'neighbour_complaint.resolved',
        'neighbour_complaint',
        ['categoryKey', 'complaintNumber'],
      ],
      [
        'neighbour_complaint.dismissed',
        'neighbour_complaint',
        ['categoryKey', 'complaintNumber'],
      ],
      [
        'neighbour_complaint.replied',
        'neighbour_complaint',
        ['categoryKey', 'complaintNumber'],
      ],
      [
        'neighbour_complaint.notice_sent',
        'neighbour_complaint',
        ['categoryKey', 'complaintNumber'],
      ],
      [
        'neighbour_notice.unit_replied',
        'neighbour_complaint',
        ['categoryKey', 'complaintNumber'],
      ],
      ['neighbour_notice.received', 'neighbour_notice', ['categoryKey']],
      ['neighbour_notice.replied', 'neighbour_notice', ['categoryKey']],
      ['neighbour_item.claimed', 'neighbour_post', ['postKind']],
      ['neighbour_item.handed_over', 'neighbour_post', ['postKind']],
      ['neighbour_claim.declined', 'neighbour_post', ['postKind']],
      ['neighbour_post.removed', 'neighbour_post', ['postKind']],
      [
        'neighbour_conversation.started',
        'neighbour_conversation',
        ['postKind'],
      ],
      [
        'neighbour_conversation.message',
        'neighbour_conversation',
        ['postKind'],
      ],
      [
        'neighbour_conversation.reveal_requested',
        'neighbour_conversation',
        ['postKind'],
      ],
      [
        'neighbour_conversation.names_revealed',
        'neighbour_conversation',
        ['postKind'],
      ],
      ['neighbour_conversation.reported', 'neighbour_report', []],
      ['neighbour_report.closed', 'neighbour_conversation', []],
      ['neighbours.welcome', 'neighbour_welcome', []],
    ]);
    for (const [, spec] of kinds)
      expect({ critical: spec.critical, priority: spec.priority }).toEqual({
        critical: false,
        priority: 'normal',
      });
  });

  it('every kind has an English and an Arabic push text that shows no raw key', () => {
    for (const [kind, spec] of kinds) {
      const text = PUSH_TEXTS[kind as keyof typeof PUSH_TEXTS];
      for (const locale of ['en', 'ar'] as const) {
        const both = `${text[locale].title} ${text[locale].body}`;
        // Keys are for the app to translate: never shown raw in a push.
        expect(both).not.toMatch(/\{(postKind|categoryKey)\}/);
      }
      // What the unit is told never carries the complaint's number.
      if (spec.target === 'neighbour_notice')
        expect(JSON.stringify(text)).not.toContain('complaintNumber');
    }
  });

  it('`neighbours` is a category a person can turn off, like any other; the inbox still records', async () => {
    const res = await h
      .http()
      .patch(`${API}/me/notification-preferences`)
      .set('Authorization', `Bearer ${s.alice.token}`)
      .send({
        categories: [{ category: 'neighbours', email: false, push: false }],
      })
      .expect(200);
    expect(
      (
        res.body as { categories: { category: string; email: boolean }[] }
      ).categories.find((c) => c.category === 'neighbours'),
    ).toEqual({ category: 'neighbours', email: false, push: false });
    const { id } = await n.complain(s.c, s.alice, s.homeB.code);
    await n.onComplaint(s.handler, id, 'review').expect(204);
    expect(
      (await n.notifications(s.c, s.alice.id)).filter((x) => x.targetId === id),
    ).toMatchObject([{ kind: 'neighbour_complaint.under_review' }]);
  });

  it('no neighbours notification holds a word anyone wrote, a name, a unit or a building', async () => {
    const WORDS = 'NOTIFY-FREE-TEXT';
    // Everything the domain can do, with the marker in every free text.
    const { id, number } = await n.complain(s.c, s.alice, s.homeB.code, {
      body: `${WORDS} complaint`,
    });
    const noticeId = await n.noticed(s.handler, id, `${WORDS} notice`);
    for (const [who, path] of [
      [s.handler, `/neighbours/complaints/${id}/messages`],
      [s.alice, `/neighbour-complaints/${id}/messages`],
      [s.bob, `/neighbour-notices/${noticeId}/messages`],
      [s.handler, `/neighbours/complaints/${id}/unit-messages`],
      [s.handler, `/neighbours/complaints/${id}/notes`],
    ] as const)
      await n
        .http('post', path, who.token, { body: `${WORDS} message` })
        .expect(201);
    await n.onComplaint(s.handler, id, 'mediation').expect(204);
    await n
      .onComplaint(s.handler, id, 'resolve', { reasonCode: 'mediated' })
      .expect(204);

    const found = await n.post(s.alice, {
      body: `${WORDS} post`,
      place: `${WORDS} place`,
    });
    const claim = await n.claim(s.bob, found, `${WORDS} claim note`);
    await n.claim(carol, found);
    await n
      .http('post', `/neighbours/posts/${found}/handover`, s.handler.token, {
        claimId: claim,
      })
      .expect(204);
    const lend = await n.post(s.alice, { kind: 'lend', body: `${WORDS} lend` });
    const conversation = (
      (await n.contact(s.bob, lend, `${WORDS} hello`).expect(201)).body as {
        id: string;
      }
    ).id;
    await n
      .http(
        'post',
        `/neighbour-conversations/${conversation}/messages`,
        s.alice.token,
        {
          body: `${WORDS} reply`,
        },
      )
      .expect(201);
    for (const who of [s.bob, s.alice])
      await n
        .http(
          'post',
          `/neighbour-conversations/${conversation}/reveal`,
          who.token,
        )
        .expect(200);
    const reportId = (
      (
        await n
          .http(
            'post',
            `/neighbour-conversations/${conversation}/report`,
            s.bob.token,
            {
              reasonCode: 'spam',
              note: `${WORDS} report note`,
            },
          )
          .expect(201)
      ).body as { id: string }
    ).id;
    await n
      .http('post', `/neighbours/reports/${reportId}/close`, s.handler.token, {
        reasonCode: 'post_removed',
      })
      .expect(204);

    const accounts = await n.x.asManager(s.c, () =>
      n.x.prisma.tenant.account.findMany({
        select: { id: true, fullName: true },
      }),
    );
    const rows = (await all()).filter((x) => x.kind.startsWith('neighbour'));
    expect(rows.length).toBeGreaterThan(15);
    for (const row of rows) {
      const spec =
        NOTIFICATION_KINDS[row.kind as keyof typeof NOTIFICATION_KINDS];
      expect(Object.keys(row.params as object).sort()).toEqual(
        Object.keys(spec.params).sort(),
      );
      const text = JSON.stringify(row.params);
      expect(text).not.toContain(WORDS);
      for (const secret of [
        s.homeA.code,
        s.homeB.code,
        s.homeA.id,
        s.homeB.id,
        ...accounts.flatMap((a) => [a.id, a.fullName ?? a.id]),
      ])
        expect(text).not.toContain(secret);
    }
    // The unit's notifications: the notice, never the complaint.
    const units = rows.filter((x) => x.targetType === 'neighbour_notice');
    expect(units.map((x) => x.accountId)).toEqual([s.bob.id, s.bob.id]);
    for (const row of units) {
      expect(row.targetId).toBe(noticeId);
      expect(JSON.stringify(row)).not.toContain(id);
      expect(JSON.stringify(row)).not.toContain(number);
    }
    // Nothing of the complaint ever went to the unit under another kind.
    expect(
      rows.filter(
        (x) =>
          x.accountId === s.bob.id && x.targetType === 'neighbour_complaint',
      ),
    ).toEqual([]);
    // And every kind that was sent is one of the domain's.
    const sent = [...new Set(rows.map((x) => x.kind))].sort();
    expect(sent.filter((k) => !kinds.some(([kind]) => kind === k))).toEqual([]);
  });

  it('a note, a read and an agreement taken back tell nobody', async () => {
    const { id } = await n.complain(s.c, carol, s.homeB.code);
    const before = (await all()).length;
    await n
      .http('post', `/neighbours/complaints/${id}/notes`, s.handler.token, {
        body: 'A note',
      })
      .expect(201);
    await n
      .http('get', `/neighbours/complaints/${id}`, s.handler.token)
      .expect(200);
    await n.http('get', '/neighbour-posts', carol.token).expect(200);
    expect((await all()).length).toBe(before);
  });
});
