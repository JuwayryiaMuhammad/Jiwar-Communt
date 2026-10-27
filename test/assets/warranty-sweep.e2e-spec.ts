import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { WARRANTY_SWEEP } from '../../src/maintenance/assets/warranty-sweep';
import { assetHelpers, type AssetSetUp } from '../setup/assets';
import { day } from '../setup/compound-clock';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0064: a warranty ending within 30 of the compound's days is
 * announced to who keeps the register, once per end date: a rerun says
 * nothing, a changed date is announced again, a retired asset never.
 */
describe('Assets — warranty notices', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof assetHelpers>;
  let s: AssetSetUp;
  let pump: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = assetHelpers(h);
    s = await a.setUp(1);
    pump = (
      (
        await a
          .http('get', '/maintenance/asset-types', s.manager.token)
          .expect(200)
      ).body as {
        data: { id: string; key: string }[];
      }
    ).data.find((t) => t.key === 'pump')!.id;
  }, 90_000);

  afterAll(() => h.close());

  const sweep = () =>
    h.moduleRef.get(SweepRunner).run(WARRANTY_SWEEP, new Date());
  const asset = async (warrantyEndsOn: string) => {
    const room = await a.area(s);
    return (
      await a
        .http('post', '/maintenance/assets', s.manager.token, {
          code: `W-${uniqueSuffix()}`,
          typeId: pump,
          commonAreaId: room.id,
          nameAr: 'مضخة',
          nameEn: 'Secret-named pump',
          warrantyEndsOn,
        })
        .expect(201)
    ).body as { id: string; code: string };
  };
  const notices = (id: string) =>
    a.inTenant(s.c, (tx) =>
      tx.notification.findMany({
        where: { kind: 'asset.warranty_expiring', targetId: id },
      }),
    );

  it('within 30 days: the keepers are told once, with the code and the day only', async () => {
    const soon = await asset(day(10));
    const far = await asset(day(45));
    const past = await asset(day(-1));
    await sweep();
    await sweep();
    const sent = await notices(soon.id);
    expect(sent.map((n) => n.accountId).sort()).toEqual(
      [s.manager.id, s.supervisor.id].sort(),
    );
    expect(sent[0].params).toEqual({ assetRef: soon.code, endsOn: day(10) });
    expect(JSON.stringify(sent)).not.toContain('Secret');
    expect(await notices(far.id)).toEqual([]);
    expect(await notices(past.id)).toEqual([]);
    // A technician reads the register, never keeps it: not told.
    expect(sent.map((n) => n.accountId)).not.toContain(s.techs[0].id);
  });

  it('a changed end date is announced again; a retired asset never', async () => {
    const moved = await asset(day(5));
    await sweep();
    await a
      .http('patch', `/maintenance/assets/${moved.id}`, s.manager.token, {
        warrantyEndsOn: day(20),
      })
      .expect(200);
    await sweep();
    // Each announcement reaches both keepers.
    expect(
      (await notices(moved.id))
        .map((n) => (n.params as { endsOn: string }).endsOn)
        .sort(),
    ).toEqual([day(5), day(5), day(20), day(20)].sort());
    const gone = await asset(day(3));
    await a
      .http('post', `/maintenance/assets/${gone.id}/retire`, s.manager.token, {
        reasonCode: 'disposed',
      })
      .expect(201);
    await sweep();
    expect(await notices(gone.id)).toEqual([]);
  });
});
