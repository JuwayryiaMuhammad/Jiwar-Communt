import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { marketHelpers, type MarketSetUp } from '../setup/market';

/**
 * ADR 0071: the gallery. The staff upload photos to an album and publish
 * it; residents see its visible photos; a privacy report hides a photo at
 * once, pending the staff, who restore it or keep it hidden.
 */
describe('Daily life — gallery', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof marketHelpers>;
  let s: MarketSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = marketHelpers(h);
    s = await m.setUp();
  }, 180_000);

  afterAll(() => h.close());

  type Album = { id: string; photos: { id: string; url: string | null }[] };
  const album = async (titleEn = 'Spring fair') =>
    (
      (
        await m
          .http('post', '/community/gallery/albums', s.manager.token, {
            titleEn,
            titleAr: 'معرض الربيع',
          })
          .expect(201)
      ).body as { id: string }
    ).id;
  const add = async (albumId: string) =>
    (
      (
        await m
          .http(
            'post',
            `/community/gallery/albums/${albumId}/photos`,
            s.manager.token,
            {
              fileId: await m.galleryPhoto(s.manager),
              caption: 'The opening',
            },
          )
          .expect(201)
      ).body as { id: string }
    ).id;
  const publish = (albumId: string) =>
    m.http(
      'post',
      `/community/gallery/albums/${albumId}/publish`,
      s.manager.token,
    );
  const seen = async (albumId: string) =>
    (await m.http('get', `/gallery/albums/${albumId}`, s.bob.token).expect(200))
      .body as Album;
  const report = (photoId: string, reasonCode: string) =>
    m.http('post', `/gallery/photos/${photoId}/report`, s.bob.token, {
      reasonCode,
    });

  it('a draft album is the staff’s; published, residents see its photos', async () => {
    const id = await album();
    const photo = await add(id);
    await m.http('get', `/gallery/albums/${id}`, s.bob.token).expect(404);
    await publish(id).expect(204);
    await publish(id).expect(409);
    const view = await seen(id);
    expect(view.photos.map((p) => p.id)).toEqual([photo]);
    expect(typeof view.photos[0].url).toBe('string');
  });

  it('a privacy report hides the photo at once; the staff are told, and restore it', async () => {
    const id = await album('Pool day');
    const photo = await add(id);
    await publish(id).expect(204);
    await report(photo, 'privacy').expect(204);
    expect((await seen(id)).photos).toEqual([]);
    await report(photo, 'privacy').expect(404);
    expect(
      (await m.notifications(s.c, s.manager.id, 'gallery_photo.reported'))
        .filter((n) => n.targetId === photo)
        .map((n) => n.params),
    ).toEqual([{ reason: 'privacy' }]);
    const staff = await m.list<{
      id: string;
      photos: { id: string; hiddenReason: string | null; reports: number }[];
    }>('/community/gallery/albums', s.manager);
    expect(staff.find((a) => a.id === id)?.photos).toMatchObject([
      { id: photo, hiddenReason: 'privacy_report', reports: 1 },
    ]);
    await m
      .http(
        'post',
        `/community/gallery/photos/${photo}/restore`,
        s.manager.token,
      )
      .expect(204);
    expect((await seen(id)).photos.map((p) => p.id)).toEqual([photo]);
  });

  it('another report leaves the photo up; the staff hide one with a code', async () => {
    const id = await album('Garden');
    const photo = await add(id);
    await publish(id).expect(204);
    await report(photo, 'other').expect(204);
    await report(photo, 'other').expect(409);
    expect((await seen(id)).photos.map((p) => p.id)).toEqual([photo]);
    await m
      .http(
        'post',
        `/community/gallery/photos/${photo}/hide`,
        s.manager.token,
        {
          reasonCode: 'inappropriate',
        },
      )
      .expect(204);
    expect((await seen(id)).photos).toEqual([]);
  });

  it('a resident never uploads or publishes', async () => {
    await m
      .http('post', '/community/gallery/albums', s.alice.token, {
        titleEn: 'Mine',
        titleAr: 'لي',
      })
      .expect(403);
  });

  it('race: a privacy report and the album’s publication at once never show the reported photo (3 rounds)', async () => {
    for (let round = 0; round < 3; round++) {
      const id = await album(`Race ${round}`);
      const photo = await add(id);
      const [published, reported] = await Promise.all([
        publish(id),
        report(photo, 'privacy'),
      ]);
      expect(published.status).toBe(204);
      expect([204, 404]).toContain(reported.status);
      const photos = (await seen(id)).photos.map((p) => p.id);
      if (reported.status === 204) expect(photos).toEqual([]);
      else expect(photos).toEqual([photo]);
    }
  });
});
