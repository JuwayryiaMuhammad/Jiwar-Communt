import { newId } from '../../src/core/common/uuid';
import { day } from '../setup/compound-clock';
import { fileHelpers } from '../setup/files';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { safetyHelpers, type Who } from '../setup/safety';

/**
 * ADR 0071, health: the emergency guides residents read (the latest of
 * each kind the compound published), and an emergency reported from one
 * of the compound's common areas by a resident away from home — the
 * responders see the area and its building.
 */
describe('Safety — emergency guides and an emergency’s place', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof safetyHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof safetyHelpers>['setUp']>>;
  let responder: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = safetyHelpers(h);
    s = await x.setUp('Health Court');
    responder = await x.staff(s.c, ['emergencies.respond']);
  }, 120_000);

  afterAll(() => h.close());

  const publish = (
    kind: string,
    titleEn: string,
    over: Record<string, unknown> = {},
  ) =>
    x
      .http('post', '/staff/compound-documents/versions', s.manager.token, {
        kind,
        titleEn,
        titleAr: 'دليل',
        bodyEn: 'Call 123, then the gate.',
        bodyAr: 'اتصل بـ 123 ثم بالبوابة.',
        effectiveOn: day(0),
        ...over,
      })
      .expect(201);

  it('residents read the latest guide of each kind published, in a fixed order', async () => {
    expect(
      (await x.http('get', '/emergency-guides', s.alice.token).expect(200))
        .body,
    ).toEqual([]);
    await publish('emergency_fire', 'Fire, first');
    // A later version says what it changes (ADR 0062).
    await publish('emergency_fire', 'Fire, second', {
      changesEn: 'The assembly point moved.',
      changesAr: 'تغيّرت نقطة التجمع.',
    });
    await publish('emergency_medical', 'Medical');
    const guides = (
      await x.http('get', '/emergency-guides', s.alice.token).expect(200)
    ).body as { kind: string; titleEn: string; bodyEn: string }[];
    expect(guides.map((g) => [g.kind, g.titleEn])).toEqual([
      ['emergency_medical', 'Medical'],
      ['emergency_fire', 'Fire, second'],
    ]);
    expect(guides[0].bodyEn).toBe('Call 123, then the gate.');
  });

  it('a guide published with its PDF is read with a presigned link, no-store', async () => {
    const fileId = await fileHelpers(h).ready(
      s.manager.token,
      'compound_document',
      'application/pdf',
    );
    await publish('emergency_security', 'Security', { fileId });
    const res = await x
      .http('get', '/emergency-guides', s.alice.token)
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const byKind = new Map(
      (
        res.body as { kind: string; hasFile: boolean; fileUrl: string | null }[]
      ).map((g) => [g.kind, g]),
    );
    expect(byKind.get('emergency_security')).toMatchObject({
      hasFile: true,
      fileUrl: expect.stringMatching(/^http/) as string,
    });
    // A guide published as text alone has no link.
    expect(byKind.get('emergency_medical')).toMatchObject({
      hasFile: false,
      fileUrl: null,
    });
  });

  it('an emergency from a common area: the responders see the area and its building', async () => {
    const areaId = newId();
    await x.v.x.asManager(s.c, () =>
      x.v.x.prisma.tenant.commonArea.create({
        data: {
          id: areaId,
          tenantId: s.c.tenantId,
          kind: 'area',
          code: `POOL-${areaId.slice(0, 6)}`,
          nameEn: 'Pool',
          nameAr: 'حمام السباحة',
          building: 'Club house',
        },
      }),
    );
    const res = await x
      .http('post', '/emergencies', s.alice.token, {
        type: 'medical',
        unitId: s.home.id,
        commonAreaId: areaId,
      })
      .expect(201);
    const id = (res.body as { id: string }).id;
    expect(
      (
        await x
          .http('get', `/gate/emergencies/${id}`, responder.token)
          .expect(200)
      ).body,
    ).toMatchObject({
      commonArea: { id: areaId, name: 'Pool', building: 'Club house' },
    });
    await x
      .http('post', '/emergencies', s.alice.token, {
        type: 'fire',
        unitId: s.home.id,
        commonAreaId: newId(),
      })
      .expect(404);
  });
});
