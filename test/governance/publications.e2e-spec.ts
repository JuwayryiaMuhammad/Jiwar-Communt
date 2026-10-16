import { fileHelpers } from '../setup/files';
import { governanceHelpers, lapse, type Who } from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface PublicationBody {
  id: string;
  kind: string;
  decidedOn: string;
  announcementId: string;
  titleEn: string | null;
  hasAttachment: boolean;
  editedAt: string | null;
  archivedAt: string | null;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * ADR 0051: the board's decisions and minutes reach the owners as
 * announcements of kind `board`, with an optional PDF, out at once and
 * pushed to nobody; governance keeps the record; the staff's own
 * announcement routes never write or change one.
 */
describe('Governance — the board’s decisions and minutes', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof governanceHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof governanceHelpers>['setUp']>>;
  let secretary: Who;
  let tenant: Who;
  let termId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = governanceHelpers(h);
    s = await g.setUp(4);
    secretary = s.owners[0];
    termId = (await g.appoint(s.manager, s.owners.slice(0, 3))).id;
    const rented = await g.unit(s.c, 'B');
    await g.landlord(s.c, rented.id);
    tenant = await g.tenant(s.c, rented.id);
  }, 180_000);

  afterAll(() => h.close());

  const code = (res: { body: unknown }) => (res.body as { code: string }).code;
  const fields = (res: { body: unknown }) =>
    (res.body as { fields: { field: string; code: string }[] }).fields.map(
      (f) => [f.field, f.code],
    );
  const publish = (by: Who, body: object = {}) =>
    g.http('post', '/governance/publications', by.token, {
      kind: 'decision',
      decidedOn: today(),
      titleEn: 'The pool reopens',
      bodyEn: 'From Saturday, 8 to 20.',
      ...body,
    });

  let decision: PublicationBody;

  it('a board member publishes a decision with its PDF: the owners read it in their feed, nobody is pushed', async () => {
    const pdf = await fileHelpers(h).ready(
      secretary.token,
      'community_attachment',
      'application/pdf',
    );
    const res = await publish(secretary, { attachmentFileId: pdf }).expect(201);
    decision = res.body as PublicationBody;
    expect(decision).toMatchObject({
      kind: 'decision',
      decidedOn: today(),
      titleEn: 'The pool reopens',
      hasAttachment: true,
      archivedAt: null,
    });
    const list = await g
      .http('get', '/governance/publications', s.owners[3].token)
      .expect(200);
    expect(
      (list.body as { data: PublicationBody[] }).data.map((p) => p.id),
    ).toEqual([decision.id]);
    const feed = await g
      .http('get', '/announcements?kind=board', s.owners[3].token)
      .expect(200);
    expect(
      (feed.body as { data: { id: string; kind: string }[] }).data,
    ).toEqual([
      expect.objectContaining({ id: decision.announcementId, kind: 'board' }),
    ]);
    const one = await g
      .http(
        'get',
        `/announcements/${decision.announcementId}`,
        s.owners[3].token,
      )
      .expect(200);
    expect((one.body as { attachments: unknown[] }).attachments).toHaveLength(
      1,
    );
    // Put to the owners: a tenant finds neither.
    await g
      .http('get', `/announcements/${decision.announcementId}`, tenant.token)
      .expect(404);
    expect(
      code(
        await g
          .http('get', '/governance/publications', tenant.token)
          .expect(404),
      ),
    ).toBe('GOVERNANCE_NOT_AVAILABLE');
    for (const o of s.owners)
      expect(
        await g.notifications(s.c, o.id, 'community_announcement.important'),
      ).toEqual([]);
  });

  it('a PDF only, a day not ahead, and never by an owner off the board', async () => {
    const png = await fileHelpers(h).ready(
      secretary.token,
      'community_attachment',
      'image/png',
    );
    expect(
      fields(await publish(secretary, { attachmentFileId: png }).expect(400)),
    ).toEqual([['attachmentFileId', 'FILE_TYPE_NOT_ALLOWED']]);
    expect(
      fields(await publish(secretary, { decidedOn: '2099-01-01' }).expect(400)),
    ).toEqual([['decidedOn', 'DAY_OUT_OF_RANGE']]);
    await publish(s.owners[3]).expect(403);
  });

  it('the staff’s routes neither write the board’s kind nor change one of its notices', async () => {
    const draft = await g
      .http('post', '/community/announcements', s.manager.token, {
        kind: 'board',
        titleEn: 'Fake',
        bodyEn: 'Fake',
      })
      .expect(400);
    expect(fields(draft)).toEqual([['kind', 'INVALID_VALUE']]);
    const id = decision.announcementId;
    for (const [method, path, body] of [
      ['patch', `/community/announcements/${id}`, { titleEn: 'Changed' }],
      ['post', `/community/announcements/${id}/publish`, {}],
      ['post', `/community/announcements/${id}/archive`, {}],
    ] as const) {
      const res = await g.http(method, path, s.manager.token, body).expect(409);
      expect(code(res)).toBe('ANNOUNCEMENT_OF_THE_BOARD');
    }
  });

  it('its words are corrected by a new version; archived, it comes down for good', async () => {
    const edited = await g
      .http(
        'patch',
        `/governance/publications/${decision.id}`,
        s.manager.token,
        {
          titleEn: 'The pool reopens on Sunday',
        },
      )
      .expect(200);
    expect(edited.body).toMatchObject({
      titleEn: 'The pool reopens on Sunday',
    });
    expect((edited.body as PublicationBody).editedAt).not.toBeNull();
    const archived = await g
      .http(
        'post',
        `/governance/publications/${decision.id}/archive`,
        secretary.token,
      )
      .expect(200);
    expect((archived.body as PublicationBody).archivedAt).not.toBeNull();
    expect(
      (
        await g
          .http('get', '/governance/publications', s.owners[3].token)
          .expect(200)
      ).body,
    ).toMatchObject({ data: [] });
    await g
      .http(
        'get',
        `/announcements/${decision.announcementId}`,
        s.owners[3].token,
      )
      .expect(404);
    const staff = await g
      .http('get', '/staff/governance/publications', s.manager.token)
      .expect(200);
    expect((staff.body as { data: PublicationBody[] }).data[0].id).toBe(
      decision.id,
    );
    expect(
      code(
        await g
          .http(
            'post',
            `/governance/publications/${decision.id}/archive`,
            secretary.token,
          )
          .expect(404),
      ),
    ).toBe('BOARD_PUBLICATION_NOT_FOUND');
  });

  it('nothing is published while no board sits', async () => {
    await lapse(termId);
    expect(code(await publish(s.manager).expect(409))).toBe(
      'BOARD_NOT_SITTING',
    );
  });
});
