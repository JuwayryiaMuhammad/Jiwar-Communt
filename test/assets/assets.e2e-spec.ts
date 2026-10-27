import { err } from '../api/request';
import { fileHelpers } from '../setup/files';
import { assetHelpers, type AssetSetUp } from '../setup/assets';
import { newId } from '../../src/core/common/uuid';
import { day } from '../setup/compound-clock';
import { uniqueSuffix } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type Card = {
  id: string;
  code: string;
  depth: number;
  parentId: string | null;
  unitId: string | null;
  commonAreaId: string | null;
  status: string;
  statusReason: string | null;
  condition: string;
  lifeYears: number | null;
  ageYears: number | null;
  underWarranty: boolean;
  childCount: number;
  health: { score: number; band: string } | null;
  type: { key: string };
  unitCode: string | null;
  commonArea: { code: string } | null;
};

/**
 * ADR 0064: the asset register. A root in a unit or a common area, parts
 * where their parent is, four levels at most; a move carries the subtree;
 * retired for good, parts first; out of service with a reason; history in
 * codes; documents with presigned reads; who keeps it and who reads it.
 */
describe('Assets — the register', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof assetHelpers>;
  let s: AssetSetUp;
  let pumpType: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = assetHelpers(h);
    s = await a.setUp(1);
    pumpType = await typeId(s, 'pump');
  }, 90_000);

  afterAll(() => h.close());

  async function typeId(at: AssetSetUp, key: string): Promise<string> {
    const res = await a
      .http('get', '/maintenance/asset-types', at.manager.token)
      .expect(200);
    return (res.body as { data: { id: string; key: string }[] }).data.find(
      (t) => t.key === key,
    )!.id;
  }
  const create = (body: object, token = s.manager.token) =>
    a.http('post', '/maintenance/assets', token, {
      code: `AS-${uniqueSuffix()}`,
      typeId: pumpType,
      nameAr: 'مضخة',
      nameEn: 'Pump',
      ...body,
    });
  const card = async (id: string) =>
    (
      await a
        .http('get', `/maintenance/assets/${id}`, s.techs[0].token)
        .expect(200)
    ).body as Card;
  const events = async (id: string) =>
    (
      (
        await a
          .http('get', `/maintenance/assets/${id}/events`, s.manager.token)
          .expect(200)
      ).body as {
        data: {
          kind: string;
          fromValue: string | null;
          toValue: string | null;
          reasonCode: string | null;
        }[];
      }
    ).data;

  it('a new compound has the default types, each under its category', async () => {
    const res = await a
      .http('get', '/maintenance/asset-types', s.techs[0].token)
      .expect(200);
    const types = (
      res.body as {
        data: { key: string; categoryId: string; expectedLifeYears: number }[];
      }
    ).data;
    expect(types.map((t) => t.key)).toEqual(
      expect.arrayContaining([
        'hvac',
        'pump',
        'generator',
        'elevator',
        'meter',
      ]),
    );
    expect(types.find((t) => t.key === 'hvac')).toMatchObject({
      categoryId: await a.categoryId(s.c, 'ac'),
      expectedLifeYears: 15,
    });
  });

  it('a root in an area, a part under it, a part of that: each where its root is, never deeper than four', async () => {
    const room = await a.area(s, { building: s.building });
    const root = (
      await create({
        commonAreaId: room.id,
        commissionedOn: '2016-01-15',
        warrantyEndsOn: day(60),
        purchaseValue: '25000.00',
        servesBuildings: [s.building],
      }).expect(201)
    ).body as Card;
    expect(root).toMatchObject({
      depth: 1,
      commonAreaId: room.id,
      commonArea: { code: room.code },
      type: { key: 'pump' },
      lifeYears: 10,
      underWarranty: true,
      health: { score: 75, band: 'good' },
    });
    expect(root.ageYears).toBeGreaterThanOrEqual(10);
    let parent = root;
    for (const depth of [2, 3, 4]) {
      parent = (await create({ parentId: parent.id }).expect(201)).body as Card;
      expect(parent).toMatchObject({
        depth,
        commonAreaId: room.id,
        unitId: null,
      });
    }
    await create({ parentId: parent.id })
      .expect(400)
      .expect((r) =>
        expect(err(r).fields).toEqual([
          { field: 'parentId', code: 'ASSET_TOO_DEEP', params: { max: 4 } },
        ]),
      );
    // A part names no place of its own; a root names exactly one.
    await create({ parentId: root.id, unitId: s.unit.id })
      .expect(400)
      .expect((r) =>
        expect(err(r).fields).toEqual([
          { field: 'unitId', code: 'FIELD_NOT_ALLOWED' },
        ]),
      );
    await create({})
      .expect(400)
      .expect((r) =>
        expect(err(r).fields).toEqual([
          { field: 'unitId', code: 'FIELD_REQUIRED' },
        ]),
      );
    await create({ unitId: s.unit.id, commonAreaId: room.id })
      .expect(400)
      .expect((r) =>
        expect(err(r).fields).toEqual([
          { field: 'commonAreaId', code: 'FIELD_NOT_ALLOWED' },
        ]),
      );
    expect((await card(root.id)).childCount).toBe(1);
    expect((await events(root.id))[0]).toMatchObject({
      kind: 'created',
      toValue: root.code,
    });
  });

  it('a unit’s asset, and who its failure reaches: counts only', async () => {
    const own = (await create({ unitId: s.unit.id }).expect(201)).body as Card;
    expect(own).toMatchObject({
      unitId: s.unit.id,
      unitCode: expect.any(String) as string,
    });
    await a
      .http('get', `/maintenance/assets/${own.id}/impact`, s.techs[0].token)
      .expect(200)
      .expect((r) =>
        expect(r.body).toEqual({ buildings: [], units: 1, occupiedUnits: 1 }),
      );
    const room = await a.area(s, { building: s.building });
    const shared = (await create({ commonAreaId: room.id }).expect(201))
      .body as Card;
    const impact = (
      await a
        .http(
          'get',
          `/maintenance/assets/${shared.id}/impact`,
          s.techs[0].token,
        )
        .expect(200)
    ).body as { buildings: string[]; units: number; occupiedUnits: number };
    expect(impact).toEqual({
      buildings: [s.building],
      units: 1,
      occupiedUnits: 1,
    });
    expect(JSON.stringify(impact)).not.toMatch(/@|\+20/);
  });

  it('an unknown or retired type, a retired area, a missing building: refused with codes', async () => {
    const room = await a.area(s);
    const chiller = (
      await a
        .http('post', '/maintenance/asset-types', s.manager.token, {
          key: `chiller_${Date.now()}`,
          nameAr: 'مبرد',
          nameEn: 'Chiller',
          categoryId: await a.categoryId(s.c, 'ac'),
        })
        .expect(201)
    ).body as { id: string };
    await a
      .http(
        'patch',
        `/maintenance/asset-types/${chiller.id}`,
        s.manager.token,
        { active: false },
      )
      .expect(200);
    await create({ commonAreaId: room.id, typeId: chiller.id })
      .expect(400)
      .expect((r) =>
        expect(err(r).fields).toEqual([
          { field: 'typeId', code: 'ASSET_TYPE_NOT_AVAILABLE' },
        ]),
      );
    await create({ commonAreaId: room.id, servesBuildings: ['Nowhere'] })
      .expect(400)
      .expect((r) =>
        expect(err(r).fields).toEqual([
          { field: 'servesBuildings.0', code: 'BUILDING_NOT_FOUND' },
        ]),
      );
    await a
      .http('patch', `/maintenance/areas/${room.id}`, s.manager.token, {
        active: false,
      })
      .expect(200);
    await create({ commonAreaId: room.id })
      .expect(409)
      .expect((r) => expect(err(r).code).toBe('COMMON_AREA_RETIRED'));
  });

  it('out of service with a reason, back without one; retired for good, parts first', async () => {
    const room = await a.area(s);
    const root = (await create({ commonAreaId: room.id }).expect(201))
      .body as Card;
    const part = (await create({ parentId: root.id }).expect(201)).body as Card;
    const status = (body: object, id = root.id) =>
      a.http('post', `/maintenance/assets/${id}/status`, s.manager.token, body);
    await status({ status: 'out_of_service' })
      .expect(400)
      .expect((r) => expect(err(r).code).toBe('REASON_REQUIRED'));
    await status({ status: 'out_of_service', reasonCode: 'breakdown' })
      .expect(201)
      .expect((r) =>
        expect(r.body).toMatchObject({
          status: 'out_of_service',
          statusReason: 'breakdown',
        }),
      );
    await status({ status: 'in_service', reasonCode: 'breakdown' }).expect(400);
    await status({ status: 'in_service' }).expect(201);
    await status({ status: 'in_service' })
      .expect(400)
      .expect((r) =>
        expect(err(r).fields).toEqual([
          { field: 'status', code: 'SAME_AS_CURRENT' },
        ]),
      );

    const retire = (id: string, reasonCode?: string) =>
      a.http(
        'post',
        `/maintenance/assets/${id}/retire`,
        s.manager.token,
        reasonCode ? { reasonCode } : {},
      );
    await retire(root.id, 'replaced')
      .expect(409)
      .expect((r) => expect(err(r).code).toBe('ASSET_HAS_ACTIVE_CHILDREN'));
    await retire(part.id, 'nonsense').expect(400);
    await retire(part.id, 'disposed').expect(201);
    const retired = (await retire(root.id, 'replaced').expect(201))
      .body as Card;
    expect(retired).toMatchObject({
      status: 'retired',
      statusReason: 'replaced',
      health: null,
    });
    for (const call of [
      a.http('patch', `/maintenance/assets/${root.id}`, s.manager.token, {
        condition: 'poor',
      }),
      status({ status: 'out_of_service', reasonCode: 'safety' }),
      retire(root.id, 'replaced'),
      a.http('post', `/maintenance/assets/${root.id}/tag`, s.manager.token),
      create({ parentId: root.id }),
    ])
      await call.expect((r) => expect([400, 409]).toContain(r.status));
    // The database itself keeps a retired asset retired.
    await expect(
      a.inTenant(
        s.c,
        (tx) =>
          tx.$executeRaw`UPDATE assets SET status = 'in_service', status_reason = NULL, retired_at = NULL WHERE id = ${root.id}::uuid`,
      ),
    ).rejects.toThrow();
    expect((await events(root.id)).map((e) => e.kind)).toEqual([
      'retired',
      'status_changed',
      'status_changed',
      'created',
    ]);
  });

  it('an update records which fields changed, a condition apart; the card’s health follows', async () => {
    const room = await a.area(s);
    const asset = (await create({ commonAreaId: room.id }).expect(201))
      .body as Card;
    const updated = (
      await a
        .http('patch', `/maintenance/assets/${asset.id}`, s.manager.token, {
          condition: 'poor',
          vendorName: 'Nile Pumps',
          vendorPhone: '+20 2 2555 0101',
          manufacturer: null,
        })
        .expect(200)
    ).body as Card;
    expect(updated).toMatchObject({
      condition: 'poor',
      health: { score: 65, band: 'watch' },
    });
    const [changed, condition] = await events(asset.id);
    expect(condition).toMatchObject({
      kind: 'condition_changed',
      fromValue: 'good',
      toValue: 'poor',
    });
    expect(changed).toMatchObject({
      kind: 'updated',
      toValue: 'vendorName,vendorPhone',
    });
    // The history holds codes: never the vendor's name or phone.
    expect(JSON.stringify(await events(asset.id))).not.toMatch(/Nile|2555/);
    // A code, a type, a parent and a place never change by update.
    await a
      .http('patch', `/maintenance/assets/${asset.id}`, s.manager.token, {
        code: 'X',
        typeId: pumpType,
      })
      .expect(400);
  });

  it('a move carries the whole subtree; a part moves only with its root', async () => {
    const from = await a.area(s);
    const to = await a.area(s);
    const root = (await create({ commonAreaId: from.id }).expect(201))
      .body as Card;
    const part = (await create({ parentId: root.id }).expect(201)).body as Card;
    const leaf = (await create({ parentId: part.id }).expect(201)).body as Card;
    await a
      .http('post', `/maintenance/assets/${part.id}/move`, s.manager.token, {
        commonAreaId: to.id,
      })
      .expect(409)
      .expect((r) => expect(err(r).code).toBe('ASSET_NOT_ROOT'));
    await a
      .http('post', `/maintenance/assets/${root.id}/move`, s.manager.token, {
        commonAreaId: from.id,
      })
      .expect(400)
      .expect((r) =>
        expect(err(r).fields).toEqual([
          { field: 'commonAreaId', code: 'SAME_AS_CURRENT' },
        ]),
      );
    await a
      .http('post', `/maintenance/assets/${root.id}/move`, s.manager.token, {
        unitId: s.unit.id,
      })
      .expect(201);
    for (const id of [root.id, part.id, leaf.id])
      expect(await card(id)).toMatchObject({
        unitId: s.unit.id,
        commonAreaId: null,
      });
    expect((await events(leaf.id))[0]).toMatchObject({
      kind: 'moved',
      fromValue: `area:${from.id}`,
      toValue: `unit:${s.unit.id}`,
    });
  });

  it('a part added while its root moves lands where the root ends up', async () => {
    for (let round = 0; round < 3; round++) {
      const from = await a.area(s);
      const to = await a.area(s);
      const root = (await create({ commonAreaId: from.id }).expect(201))
        .body as Card;
      const [moved, added] = await Promise.all([
        a.http('post', `/maintenance/assets/${root.id}/move`, s.manager.token, {
          commonAreaId: to.id,
        }),
        create({ parentId: root.id }),
      ]);
      expect([moved.status, added.status]).toEqual([201, 201]);
      expect(await card((added.body as Card).id)).toMatchObject({
        commonAreaId: to.id,
      });
    }
  });

  it('a tag is shown once and replaced; technicians read the register, never write it', async () => {
    const room = await a.area(s);
    const asset = (await create({ commonAreaId: room.id }).expect(201))
      .body as Card;
    const tag = await a
      .http('post', `/maintenance/assets/${asset.id}/tag`, s.manager.token)
      .expect(201);
    expect(tag.headers['cache-control']).toBe('no-store');
    expect(
      (tag.body as { code: string }).code.startsWith(`JWA1.${asset.id}.`),
    ).toBe(true);
    const tech = s.techs[0].token;
    await a.http('get', '/maintenance/assets?limit=5', tech).expect(200);
    await a
      .http('get', `/maintenance/assets/${asset.id}/events`, tech)
      .expect(200);
    await create({ commonAreaId: room.id }, tech).expect(403);
    await a
      .http('patch', `/maintenance/assets/${asset.id}`, tech, {
        condition: 'poor',
      })
      .expect(403);
    await a.http('get', '/maintenance/assets', s.owner.token).expect(403);
    // The list filters.
    const listed = (
      await a
        .http('get', `/maintenance/assets?commonAreaId=${room.id}`, tech)
        .expect(200)
    ).body as { data: { id: string }[] };
    expect(listed.data.map((x) => x.id)).toEqual([asset.id]);
  });

  it('documents: added once per file, read through presigned URLs, removed once, fifty a subject', async () => {
    const files = fileHelpers(h);
    const room = await a.area(s);
    const asset = (await create({ commonAreaId: room.id }).expect(201))
      .body as Card;
    const file = () =>
      files.ready(s.manager.token, 'asset_document', 'application/pdf');
    const add = (subject: object, fileId: string) =>
      a.http('post', '/maintenance/documents', s.manager.token, {
        ...subject,
        fileId,
        kind: 'manual',
        title: 'Pump manual',
      });
    const doc = (await add({ assetId: asset.id }, await file()).expect(201))
      .body as {
      id: string;
      url: string;
    };
    expect(doc.url).toEqual(expect.any(String));
    await add({ commonAreaId: room.id }, await file()).expect(201);
    await add({ assetTypeId: pumpType }, await file()).expect(201);
    await add({ assetId: asset.id, commonAreaId: room.id }, await file())
      .expect(400)
      .expect((r) =>
        expect(err(r).fields).toEqual([
          { field: 'commonAreaId', code: 'FIELD_NOT_ALLOWED' },
        ]),
      );
    // A file of another purpose, or the same file twice, is not available.
    await a
      .http('post', '/maintenance/documents', s.manager.token, {
        assetId: asset.id,
        fileId: await files.ready(s.manager.token, 'community_attachment'),
        kind: 'photo',
        title: 'Photo',
      })
      .expect(400);
    const listed = await a
      .http(
        'get',
        `/maintenance/documents?assetId=${asset.id}`,
        s.techs[0].token,
      )
      .expect(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(
      (listed.body as { data: { id: string }[] }).data.map((d) => d.id),
    ).toEqual([doc.id]);
    await a
      .http('post', `/maintenance/documents/${doc.id}/remove`, s.techs[0].token)
      .expect(403);
    await a
      .http('post', `/maintenance/documents/${doc.id}/remove`, s.manager.token)
      .expect(204);
    await a
      .http('post', `/maintenance/documents/${doc.id}/remove`, s.manager.token)
      .expect(404)
      .expect((r) =>
        expect(err(r).code).toBe('MAINTENANCE_DOCUMENT_NOT_FOUND'),
      );
    expect(
      (
        (
          await a
            .http(
              'get',
              `/maintenance/documents?assetId=${asset.id}`,
              s.manager.token,
            )
            .expect(200)
        ).body as { data: unknown[] }
      ).data,
    ).toEqual([]);
    const row = await a.inTenant(s.c, (tx) =>
      tx.maintenanceDocument.findUniqueOrThrow({ where: { id: doc.id } }),
    );
    expect(row.removedAt).not.toBeNull();
    await expect(
      a.inTenant(
        s.c,
        (tx) =>
          tx.$executeRaw`UPDATE maintenance_documents SET title = 'x' WHERE id = ${doc.id}::uuid`,
      ),
    ).rejects.toThrow();
    // Another compound's asset: not found.
    const other = await a.setUp(0);
    const theirs = await a.area(other);
    const foreign = (
      await a
        .http('post', '/maintenance/assets', other.manager.token, {
          code: `F-${uniqueSuffix()}`,
          typeId: await typeId(other, 'pump'),
          commonAreaId: theirs.id,
          nameAr: 'م',
          nameEn: 'P',
        })
        .expect(201)
    ).body as Card;
    await a
      .http(
        'get',
        `/maintenance/documents?assetId=${foreign.id}`,
        s.manager.token,
      )
      .expect(404)
      .expect((r) => expect(err(r).code).toBe('ASSET_NOT_FOUND'));
  });

  it('fifty documents at most, even added at once', async () => {
    const files = fileHelpers(h);
    const room = await a.area(s);
    const asset = (await create({ commonAreaId: room.id }).expect(201))
      .body as Card;
    await a.inTenant(s.c, async (tx) => {
      for (let i = 0; i < 48; i++) {
        const file = await tx.storedFile.create({
          data: {
            id: newId(),
            tenantId: s.c.tenantId,
            purpose: 'asset_document',
            contentType: 'application/pdf',
            sizeBytes: 10,
            status: 'ready',
            uploadExpiresAt: new Date(),
            // Attached to its document, as the service leaves it.
            finalizedAt: new Date(),
            attachedAt: new Date(),
          },
        });
        await tx.maintenanceDocument.create({
          data: {
            id: newId(),
            tenantId: s.c.tenantId,
            assetId: asset.id,
            fileId: file.id,
            kind: 'other',
            title: `Doc ${i}`,
            addedAt: new Date(),
          },
        });
      }
    });
    const ids = await Promise.all(
      [0, 1, 2, 3].map(() =>
        files.ready(s.manager.token, 'asset_document', 'application/pdf'),
      ),
    );
    const results = await Promise.all(
      ids.map((fileId) =>
        a.http('post', '/maintenance/documents', s.manager.token, {
          assetId: asset.id,
          fileId,
          kind: 'manual',
          title: 'Racing manual',
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 409, 409]);
  });

  it('the history is append-only', async () => {
    const room = await a.area(s);
    const asset = (await create({ commonAreaId: room.id }).expect(201))
      .body as Card;
    await expect(
      a.inTenant(
        s.c,
        (tx) =>
          tx.$executeRaw`UPDATE asset_events SET kind = 'moved' WHERE asset_id = ${asset.id}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      a.inTenant(
        s.c,
        (tx) =>
          tx.$executeRaw`DELETE FROM asset_events WHERE asset_id = ${asset.id}::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('an Idempotency-Key replays the creation', async () => {
    const room = await a.area(s);
    const key = `asset-${Date.now()}`;
    const body = {
      code: `IK-${uniqueSuffix()}`,
      typeId: pumpType,
      commonAreaId: room.id,
      nameAr: 'مضخة',
      nameEn: 'Pump',
    };
    const one = await a
      .http('post', '/maintenance/assets', s.manager.token, body)
      .set('Idempotency-Key', key)
      .expect(201);
    const two = await a
      .http('post', '/maintenance/assets', s.manager.token, body)
      .set('Idempotency-Key', key)
      .expect(201);
    expect((two.body as { id: string }).id).toBe(
      (one.body as { id: string }).id,
    );
  });
});
