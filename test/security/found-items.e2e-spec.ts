import { FOUND_ITEM_RETENTION_SWEEP } from '../../src/gate/found-items/found-items.service';
import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityHelpers, type Who } from '../setup/security';

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});
const fields = (res: { body: unknown }) =>
  (res.body as { fields?: unknown[] }).fields;

interface ItemBody {
  id: string;
  status: string;
  place: { key: string | null } | null;
  location: string | null;
  registeredAt: { gateId: string | null } | null;
  registeredBy: {
    id: string;
    firstName?: string | null;
    fullName?: string | null;
  };
  claim: {
    unitCode: string | null;
    name: string | null;
    note: string | null;
  } | null;
  photos: { url: string }[];
}

/**
 * ADR 0050: the gate's lost-and-found register. A guard on shift
 * registers what was found — what, where, when, photos — and records its
 * owner's claim at the gate; the management receives an item from the
 * gate and records claims at the office. A claimant is a unit and/or a
 * name as told; the name goes after 30 days, as a visitor's.
 */
describe('Lost and found at the gate', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityHelpers>['setUp']>>;
  let guard: Who;
  let gateId: string;
  let homeCode: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityHelpers(h);
    s = await x.setUp('Found Court');
    guard = await x.guard(s.c);
    gateId = (await x.g.gate(s.c)).id;
    await x.start(guard, { gateId });
    homeCode = (
      await x.inTx(s.c, (tx) =>
        tx.unit.findUniqueOrThrow({ where: { id: s.home.id } }),
      )
    ).code;
  }, 120_000);

  afterAll(() => h.close());

  const register = async (body: Record<string, unknown> = {}) =>
    (
      await x
        .http('post', '/gate/found-items', guard.token, {
          description: 'A black wallet',
          ...body,
        })
        .expect(201)
    ).body as ItemBody;

  it('registered on shift with its place, words and photo; the guards see who by first name', async () => {
    const places = await x.places(guard);
    const photo = await x.files.ready(guard.token, 'found_item_photo');
    const item = await register({
      placeId: places.clubhouse.id,
      location: 'By the pool',
      photoFileIds: [photo],
    });
    expect(item).toMatchObject({
      status: 'at_gate',
      place: { key: 'clubhouse' },
      location: 'By the pool',
      registeredAt: { gateId },
      registeredBy: { id: guard.id, firstName: expect.any(String) as string },
      claim: null,
    });
    expect(item.photos).toHaveLength(1);
    expect(Object.keys(item.registeredBy)).not.toContain('fullName');
    const offShift = await x.guard(s.c);
    expect(
      code(
        await x.http('post', '/gate/found-items', offShift.token, {
          description: 'Keys',
        }),
      ),
    ).toEqual({ status: 403, code: 'NO_OPEN_SHIFT' });
  });

  it('claimed at the gate by a unit and a name, once', async () => {
    const item = await register();
    const path = `/gate/found-items/${item.id}/claim`;
    expect(fields(await x.http('post', path, guard.token, {}))).toEqual([
      { field: 'name', code: 'FIELD_REQUIRED' },
    ]);
    expect(
      fields(await x.http('post', path, guard.token, { unitCode: 'NO-SUCH' })),
    ).toEqual([{ field: 'unitCode', code: 'UNIT_CODE_UNKNOWN' }]);
    const claimed = (
      await x
        .http('post', path, guard.token, {
          unitCode: homeCode,
          name: 'Alice',
          note: 'Showed an ID',
        })
        .expect(200)
    ).body as ItemBody;
    expect(claimed).toMatchObject({
      status: 'claimed',
      claim: { unitCode: homeCode, name: 'Alice', note: 'Showed an ID' },
    });
    expect(
      code(await x.http('post', path, guard.token, { name: 'Bob' })),
    ).toEqual({ status: 409, code: 'FOUND_ITEM_CLOSED' });
    const [entry] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'found_item.claimed',
      targetId: item.id,
    });
    expect(entry.metadata).toEqual({
      unitId: s.home.id,
      name: true,
      note: true,
    });
  });

  it('received by the management, then claimed at the office; the gate claims it no more', async () => {
    const item = await register();
    await x
      .http(
        'post',
        `/staff/security/found-items/${item.id}/receive`,
        s.manager.token,
      )
      .expect(200);
    expect(
      code(
        await x.http(
          'post',
          `/gate/found-items/${item.id}/claim`,
          guard.token,
          {
            name: 'Carol',
          },
        ),
      ),
    ).toEqual({ status: 409, code: 'FOUND_ITEM_CLOSED' });
    const claimed = (
      await x
        .http(
          'post',
          `/staff/security/found-items/${item.id}/claim`,
          s.manager.token,
          {
            name: 'Carol',
          },
        )
        .expect(200)
    ).body as ItemBody & {
      receivedBy: { id: string };
      claimRecordedBy: { id: string };
    };
    expect(claimed).toMatchObject({
      status: 'claimed',
      receivedBy: { id: s.manager.id },
      claimRecordedBy: { id: s.manager.id },
    });
    expect(
      code(
        await x.http(
          'post',
          `/staff/security/found-items/${item.id}/receive`,
          s.manager.token,
        ),
      ),
    ).toEqual({ status: 409, code: 'FOUND_ITEM_CLOSED' });
  });

  it('a claimant’s name goes after 30 days; the unit stays', async () => {
    const item = await register();
    await x
      .http('post', `/gate/found-items/${item.id}/claim`, guard.token, {
        unitCode: homeCode,
        name: 'Dina',
      })
      .expect(200);
    await x.sweep(
      FOUND_ITEM_RETENTION_SWEEP,
      new Date(Date.now() + 29 * 86_400_000),
    );
    let row = await x.inTx(s.c, (tx) =>
      tx.foundItem.findUniqueOrThrow({ where: { id: item.id } }),
    );
    expect(row.claimantName).toBe('Dina');
    await x.sweep(
      FOUND_ITEM_RETENTION_SWEEP,
      new Date(Date.now() + 31 * 86_400_000),
    );
    row = await x.inTx(s.c, (tx) =>
      tx.foundItem.findUniqueOrThrow({ where: { id: item.id } }),
    );
    expect(row).toMatchObject({
      claimantName: null,
      claimantUnitId: s.home.id,
      claimantNameClearedAt: expect.any(Date) as Date,
    });
    const read = (
      await x
        .http('get', `/staff/security/found-items/${item.id}`, s.manager.token)
        .expect(200)
    ).body as ItemBody;
    expect(read.claim).toMatchObject({ unitCode: homeCode, name: null });
  });

  it('the management registers at the office: no post', async () => {
    const item = (
      await x
        .http('post', '/staff/security/found-items', s.manager.token, {
          description: 'A child’s jacket',
        })
        .expect(201)
    ).body as ItemBody;
    expect(item.registeredAt).toBeNull();
    expect(item.registeredBy).toEqual({
      id: s.manager.id,
      fullName: expect.any(String) as string,
    });
  });
});
