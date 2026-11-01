import { auditReaders } from '../setup/audit';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { deferred, permitHelpers, type PermitSetUp } from '../setup/permits';

interface Stage {
  id: string;
  note: string | null;
  photos: ({ url: string } | null)[];
}
interface FitOutBody {
  areas: {
    commonArea: { id: string; code: string };
    before: Stage | null;
    after: Stage | null;
  }[];
}

/**
 * The common areas before and after a works permit's works (ADR 0074):
 * the management's photos and a note the household reads, once per area
 * and stage, `after` only once `before` is recorded.
 */
describe('Fit-out — areas before and after', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  const area = async (s: PermitSetUp) =>
    (
      await p
        .http('post', '/maintenance/areas', s.manager.token, {
          kind: 'area',
          code: `FA-${uniqueSuffix()}`,
          nameAr: 'المدخل',
          nameEn: 'Lobby',
        })
        .expect(201)
    ).body as { id: string; code: string };
  const recordRaw = (
    s: PermitSetUp,
    permitId: string,
    commonAreaId: string,
    phase: 'before' | 'after',
    over: Record<string, unknown> = {},
  ) =>
    deferred(
      (async () =>
        p.http(
          'post',
          `/staff/unit-permits/${permitId}/area-records`,
          s.manager.token,
          {
            commonAreaId,
            phase,
            photoFileIds: [
              await p.files.ready(s.manager.token, 'fitout_photo'),
            ],
            ...over,
          },
        ))(),
    );

  it('before, then after, once each: the household reads both with the photos and the note', async () => {
    const s = await p.setUp('Areas Court');
    const permit = await p.works(s.alice, s.home.id);
    const lobby = await area(s);
    expect(
      (await recordRaw(s, permit.id, lobby.id, 'after').expect(409)).body,
    ).toMatchObject({
      code: 'PERMIT_NOT_ACTIVE',
      params: { status: 'pending' },
    });
    const before = await recordRaw(s, permit.id, lobby.id, 'before', {
      note: 'Clean walls, no scratches.',
    }).expect(201);
    expect(before.headers['cache-control']).toBe('no-store');
    expect(
      (await recordRaw(s, permit.id, lobby.id, 'before').expect(409)).body,
    ).toMatchObject({
      code: 'AREA_RECORD_EXISTS',
      params: { phase: 'before' },
    });
    await p.approve(s.manager, permit.id);
    const other = await area(s);
    expect(
      (await recordRaw(s, permit.id, other.id, 'after').expect(409)).body,
    ).toMatchObject({ code: 'AREA_RECORD_NO_BEFORE' });
    await recordRaw(s, permit.id, lobby.id, 'after', {
      photoFileIds: [
        await p.files.ready(s.manager.token, 'fitout_photo'),
        await p.files.ready(s.manager.token, 'fitout_photo'),
      ],
    }).expect(201);
    const mine = (
      await p
        .http('get', `/permits/${permit.id}/fit-out`, s.alice.token)
        .expect(200)
    ).body as FitOutBody;
    expect(mine.areas).toHaveLength(1);
    expect(mine.areas[0]).toMatchObject({
      commonArea: { id: lobby.id, code: lobby.code },
      before: { note: 'Clean walls, no scratches.' },
      after: { note: null },
    });
    expect(mine.areas[0].before!.photos).toHaveLength(1);
    expect(mine.areas[0].after!.photos).toHaveLength(2);
    const rows = await read.tenant(s.c.tenantId, {
      action: 'area_record.recorded',
    });
    expect(rows.map((r) => r.metadata)).toEqual([
      {
        permitId: permit.id,
        commonAreaId: lobby.id,
        phase: 'before',
        photos: 1,
        note: true,
      },
      {
        permitId: permit.id,
        commonAreaId: lobby.id,
        phase: 'after',
        photos: 2,
        note: false,
      },
    ]);
  });

  it('an inactive or unknown area, or another’s photo, is refused; two at once for one stage: one recorded', async () => {
    const s = await p.setUp('Areas Refused Court');
    const permit = await p.works(s.alice, s.home.id);
    const lobby = await area(s);
    expect(
      (
        await recordRaw(
          s,
          permit.id,
          '0192a5f0-1c2b-7d3e-8f40-0000000074e1',
          'before',
        ).expect(400)
      ).body,
    ).toMatchObject({
      fields: [{ field: 'commonAreaId', code: 'INVALID_VALUE' }],
    });
    expect(
      (
        await recordRaw(s, permit.id, lobby.id, 'before', {
          photoFileIds: [await p.files.ready(s.alice.token, 'permit_drawing')],
        }).expect(404)
      ).body,
    ).toMatchObject({ code: 'FILE_NOT_FOUND' });
    const both = await Promise.all([
      recordRaw(s, permit.id, lobby.id, 'before'),
      recordRaw(s, permit.id, lobby.id, 'before'),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
  });
});
