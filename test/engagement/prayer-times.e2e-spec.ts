import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { marketHelpers, type MarketSetUp } from '../setup/market';

/**
 * ADR 0071: prayer times, computed on read from where the compound is, its
 * method and its school for Asr. None until the manager sets the place.
 */
describe('Daily life — prayer times', () => {
  let h: HttpHarness;
  let m: ReturnType<typeof marketHelpers>;
  let s: MarketSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    m = marketHelpers(h);
    s = await m.setUp();
  }, 180_000);

  afterAll(() => h.close());

  type Times = Record<
    'fajr' | 'sunrise' | 'dhuhr' | 'asr' | 'maghrib' | 'isha',
    string
  > & { on: string; timeZone: string };
  const settings = (body: object) =>
    m.http('patch', '/community/prayer-settings', s.manager.token, body);
  const times = async (on = day(0)) =>
    (await m.http('get', `/prayer-times?on=${on}`, s.bob.token).expect(200))
      .body as Times;

  it('none until the place is set; then the day’s six times, in order, and in the brief', async () => {
    expect(
      (await m.http('get', '/prayer-times', s.bob.token).expect(409)).body,
    ).toMatchObject({ code: 'PRAYER_PLACE_NOT_SET' });
    expect(
      (await m.http('get', '/me/daily-brief', s.bob.token).expect(200)).body,
    ).toMatchObject({ prayer: null });
    expect(
      (
        await settings({
          latitude: '30.044420',
          longitude: '31.235712',
        }).expect(200)
      ).body,
    ).toEqual({
      latitude: '30.044420',
      longitude: '31.235712',
      prayerMethod: 'egyptian',
      asrMadhab: 'shafi',
    });
    const t = await times();
    expect(t).toMatchObject({ on: day(0), timeZone: 'Africa/Cairo' });
    const order = [t.fajr, t.sunrise, t.dhuhr, t.asr, t.maghrib, t.isha].map(
      (x) => Date.parse(x),
    );
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Within a day of each other, Cairo's prayers.
    expect(order[5] - order[0]).toBeLessThan(20 * 3_600_000);
    expect(
      (await m.http('get', '/me/daily-brief', s.bob.token).expect(200)).body,
    ).toMatchObject({ prayer: { on: day(0), dhuhr: t.dhuhr } });
  });

  it('the Hanafi Asr is later than the Shafi one; the rest stay', async () => {
    const shafi = await times(day(1));
    await settings({ asrMadhab: 'hanafi' }).expect(200);
    const hanafi = await times(day(1));
    expect(Date.parse(hanafi.asr)).toBeGreaterThan(Date.parse(shafi.asr));
    expect(hanafi.dhuhr).toBe(shafi.dhuhr);
    await settings({ asrMadhab: 'shafi' }).expect(200);
  });

  it('a place is both coordinates or neither, in range; a resident never sets it', async () => {
    expect(
      (
        (await settings({ latitude: '30.1' }).expect(400)).body as {
          fields: object[];
        }
      ).fields,
    ).toMatchObject([{ field: 'longitude', code: 'FIELD_REQUIRED' }]);
    await settings({ latitude: '91', longitude: '31' }).expect(400);
    await m
      .http('patch', '/community/prayer-settings', s.alice.token, {
        asrMadhab: 'hanafi',
      })
      .expect(403);
    await settings({ latitude: null, longitude: null }).expect(200);
    await m.http('get', '/prayer-times', s.bob.token).expect(409);
  });
});
