import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { M29_COVERAGE } from '../setup/audit-coverage-split';
import { engagementHelpers, type EngagementSetUp } from '../setup/engagement';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { managementHelpers } from '../setup/management';

const MARKER = 'AUDIT-m29-secret';

/**
 * One scenario per entry of the office queue's catalog (ADR 0014, 0080):
 * actor, target and metadata — codes, ids, counts and names of templates,
 * never a resident's or staff's words.
 */
const covered = new Set<string>();

describe('Audit coverage — announcements and the office queue', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof engagementHelpers>;
  let m: ReturnType<typeof managementHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: EngagementSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    e = engagementHelpers(h);
    m = managementHelpers(h);
    read = auditReaders(h);
    s = await e.setUp();
  }, 120_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const rows = await read.tenant(s.c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(MARKER);
    covered.add(action);
    return rows[0];
  }

  it('announcement.reminded — the counts, never who', async () => {
    const id = await e.announcement(s.manager, {
      bodyEn: `Water ${MARKER}`,
    });
    await e
      .http('post', `/community/announcements/${id}/remind`, s.manager.token)
      .expect(200);
    expect((await single('announcement.reminded', id)).metadata).toEqual({
      recipients: 1,
      audience: 1,
    });
  });

  it('announcement_template.created, .changed, .deleted — the name; the words as changed', async () => {
    const path = '/community/announcement-templates';
    const id = (
      (
        await e
          .http('post', path, s.manager.token, {
            name: 'Cut',
            titleEn: 'Cut',
            bodyEn: MARKER,
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    expect(
      (await single('announcement_template.created', id)).metadata,
    ).toEqual({ name: 'Cut' });
    await e
      .http('patch', `${path}/${id}`, s.manager.token, {
        name: 'Water cut',
        bodyEn: `${MARKER} again`,
      })
      .expect(200);
    expect((await single('announcement_template.changed', id)).changes).toEqual(
      {
        name: { from: 'Cut', to: 'Water cut' },
        words: { changed: true },
      },
    );
    await e.http('delete', `${path}/${id}`, s.manager.token).expect(204);
    expect(
      (await single('announcement_template.deleted', id)).metadata,
    ).toEqual({ name: 'Water cut' });
  });

  it('management_request.outreach_started — codes and the resident’s id', async () => {
    const id = (
      (
        await e
          .http('post', '/management/outreach', s.manager.token, {
            residentAccountId: s.owner.id,
            topicId: await m.topicId(s.c),
            body: MARKER,
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    expect(
      (await single('management_request.outreach_started', id)).metadata,
    ).toMatchObject({ topicKey: 'general', authorId: s.owner.id });
  });

  it('management_request.reclassified — the keys by value', async () => {
    const { id } = await m.open(s.c, s.owner, { body: MARKER });
    const other = await e.inTx(s.c, (tx) =>
      tx.managementRequestTopic.findFirstOrThrow({
        where: {
          key: { notIn: ['general', 'release_request', 'partner_service'] },
          active: true,
        },
      }),
    );
    await e
      .http('post', `/management/requests/${id}/topic`, s.manager.token, {
        topicId: other.id,
      })
      .expect(204);
    expect(
      (await single('management_request.reclassified', id)).changes,
    ).toEqual({ topicKey: { from: 'general', to: other.key } });
  });

  it('management_request.converted — the ticket’s id, never the words', async () => {
    const { id } = await m.open(s.c, s.owner, {
      unitId: s.home.id,
      body: MARKER,
    });
    const categoryId = await e.inTx(
      s.c,
      async (tx) =>
        (
          await tx.ticketCategory.findFirstOrThrow({
            where: { key: 'plumbing' },
          })
        ).id,
    );
    const ticket = (
      await e
        .http('post', `/management/requests/${id}/convert`, s.manager.token, {
          target: 'ticket',
          categoryId,
          description: MARKER,
        })
        .expect(201)
    ).body as { id: string };
    expect(
      (await single('management_request.converted', id)).metadata,
    ).toMatchObject({ ticketId: ticket.id });
  });

  it('reply_template.created, .changed, .deleted — name and topic; the words as changed', async () => {
    const path = '/management/reply-templates';
    const id = (
      (
        await e
          .http('post', path, s.manager.token, {
            name: 'Thanks',
            bodyEn: MARKER,
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    expect((await single('reply_template.created', id)).metadata).toEqual({
      name: 'Thanks',
      topicId: null,
    });
    await e
      .http('patch', `${path}/${id}`, s.manager.token, {
        bodyEn: `${MARKER} again`,
      })
      .expect(200);
    expect((await single('reply_template.changed', id)).changes).toEqual({
      words: { changed: true },
    });
    await e.http('delete', `${path}/${id}`, s.manager.token).expect(204);
    expect((await single('reply_template.deleted', id)).metadata).toEqual({
      name: 'Thanks',
      topicId: null,
    });
  });

  it('official_letter.issued, .revoked — codes and flags; never the name, the addressee or the subject', async () => {
    const letter = (
      await e
        .http('post', '/staff/official-letters', s.manager.token, {
          kind: 'no_objection',
          unitId: s.home.id,
          accountId: s.owner.id,
          addressee: MARKER,
          subject: MARKER,
        })
        .expect(201)
    ).body as { id: string; number: string };
    expect(
      (await single('official_letter.issued', letter.id)).metadata,
    ).toEqual({
      number: letter.number,
      kind: 'no_objection',
      unitId: s.home.id,
      accountId: s.owner.id,
      withRequest: false,
      withAddressee: true,
      withSubject: true,
    });
    await e
      .http(
        'post',
        `/staff/official-letters/${letter.id}/revoke`,
        s.manager.token,
        { reasonCode: 'replaced' },
      )
      .expect(204);
    expect(
      (await single('official_letter.revoked', letter.id)).metadata,
    ).toEqual({ number: letter.number, reasonCode: 'replaced' });
  });

  it('unit.correspondence_read — the unit and a count', async () => {
    await e
      .http(
        'get',
        `/staff/units/${s.home.id}/correspondence?type=official_letter`,
        s.manager.token,
      )
      .expect(200);
    expect(
      (await single('unit.correspondence_read', s.home.id)).metadata,
    ).toEqual({ rows: 1, type: 'official_letter' });
  });

  describe('catalog completeness', () => {
    it('every entry of the office queue has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of M29_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...M29_COVERAGE].sort());
    });
  });
});
