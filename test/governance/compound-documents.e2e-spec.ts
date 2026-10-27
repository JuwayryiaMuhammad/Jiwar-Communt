import { today } from '../setup/compound-clock';
import { governanceHelpers, type Who } from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface Version {
  id: string;
  kind: string;
  versionNo: number;
  bodyEn?: string;
  changesEn?: string | null;
  boardPublicationId?: string | null;
  code?: string;
}

/** The compound's documents, versioned (ADR 0062). */
describe('Compound documents', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof governanceHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof governanceHelpers>['setUp']>>;
  let reader: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = governanceHelpers(h);
    s = await g.setUp(4);
    reader = s.owners[3];
  }, 180_000);

  afterAll(() => h.close());

  const text = {
    titleEn: 'Your rights',
    titleAr: 'حقوقك',
    bodyEn: 'You may use the pool.',
    bodyAr: 'يمكنك استخدام المسبح.',
    effectiveOn: '2026-01-01',
  };
  const publish = (kind: string, body: object = {}) =>
    g.http('post', '/staff/compound-documents/versions', s.manager.token, {
      kind,
      ...text,
      ...body,
    });
  const body = (res: { body: unknown }) => res.body as Version;

  it('versions: the first says no changes, the next say what they change; everyone is told', async () => {
    const first = await publish('occupant_rights');
    expect(first.status).toBe(201);
    expect(body(first)).toMatchObject({ versionNo: 1, changesEn: null });
    expect(
      body(await publish('occupant_rights', { bodyEn: 'Also the gym.' })).code,
    ).toBe('VALIDATION_FAILED');
    const second = await publish('occupant_rights', {
      bodyEn: 'Also the gym.',
      changesEn: 'Adds the gym.',
      changesAr: 'تضيف النادي.',
    });
    expect(body(second)).toMatchObject({ versionNo: 2 });

    const versions = (
      await g.http(
        'get',
        '/compound-documents/versions?kind=occupant_rights',
        reader.token,
      )
    ).body as Version[];
    expect(versions.map((v) => v.versionNo)).toEqual([2, 1]);
    // The editor reads the latest from its own side: a manager holds no community.read.
    const staffView = await g
      .http('get', '/staff/compound-documents', s.manager.token)
      .expect(200);
    expect(
      (staffView.body as Version[]).map((v) => [v.kind, v.versionNo]),
    ).toEqual([['occupant_rights', 2]]);
    const old = body(
      await g.http(
        'get',
        `/compound-documents/versions/${body(first).id}`,
        reader.token,
      ),
    );
    expect(old.bodyEn).toBe(text.bodyEn);
    expect(
      (
        await g.http(
          'get',
          '/compound-documents/versions/0192a5f0-1c2b-7d3e-8f40-0000000062b2',
          reader.token,
        )
      ).status,
    ).toBe(404);
    const told = await g.x.asManager(s.c, () =>
      g.x.prisma.tenant.notification.count({
        where: { accountId: reader.id, kind: 'compound_document.published' },
      }),
    );
    expect(told).toBe(2);
  });

  it('the bylaws cite the board’s published decision', async () => {
    expect(body(await publish('bylaws')).code).toBe('VALIDATION_FAILED');
    expect(
      body(
        await publish('bylaws', {
          boardPublicationId: '0192a5f0-1c2b-7d3e-8f40-0000000062b1',
        }),
      ).code,
    ).toBe('BOARD_PUBLICATION_NOT_FOUND');
    await g.appoint(s.manager, s.owners.slice(0, 3));
    const decision = await g.http(
      'post',
      '/governance/publications',
      s.manager.token,
      {
        kind: 'decision',
        decidedOn: today(),
        titleEn: 'Bylaws adopted',
        bodyEn: 'Adopted.',
      },
    );
    expect(decision.status).toBe(201);
    const adopted = await publish('bylaws', {
      boardPublicationId: (decision.body as { id: string }).id,
    });
    expect(adopted.status).toBe(201);
    // A guide cites nothing.
    expect(
      body(
        await publish('conduct_guide', {
          boardPublicationId: (decision.body as { id: string }).id,
        }),
      ).code,
    ).toBe('VALIDATION_FAILED');
  });

  it('race: two publications of one kind are numbered one after the other', async () => {
    const both = await Promise.all([
      publish('moving_guide'),
      publish('moving_guide', { changesEn: 'x', changesAr: 'س' }),
    ]);
    // Whichever comes first is version 1; the other must then be an
    // amendment: one of the two answers is a validation error.
    const made = both
      .filter((r) => r.status === 201)
      .map((r) => body(r).versionNo);
    expect(made.length).toBeGreaterThanOrEqual(1);
    expect(new Set(made).size).toBe(made.length);
  });

  it('a version never changes', async () => {
    await expect(
      g.x.asManager(s.c, () =>
        g.x.prisma.tenant.compoundDocumentVersion.updateMany({
          where: { kind: 'occupant_rights' },
          data: { bodyEn: 'Rewritten' },
        }),
      ),
    ).rejects.toThrow();
  });
});
