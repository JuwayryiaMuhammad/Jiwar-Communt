import type { Response } from 'supertest';
import { ParcelTokens } from '../../src/gate/parcels/parcel-tokens';
import { call, err } from '../api/request';
import { buildWorld, type World } from '../api/world';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { parcelScenes } from '../setup/parcels';
import { whileShiftEnds } from '../setup/shift-end';

/**
 * A guard's parcel work while their shift ends (ADR 0035, ADR 0056's lock
 * order): the receipt, the hand-over and the return take the account, then
 * the shift, FOR SHARE. Each waits for the end, then is refused, and
 * nothing is written by a guard off duty.
 */
describe('Parcels — races', () => {
  let h: HttpHarness;
  let w: World;
  let s: ReturnType<typeof parcelScenes>;
  let tokens: ParcelTokens;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
    s = parcelScenes(w);
    tokens = h.moduleRef.get(ParcelTokens);
  }, 120_000);

  afterAll(() => h.close());

  const parcel = (id: string) =>
    w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.parcel.findUniqueOrThrow({ where: { id } }),
    );
  const holderCode = async (parcelId: string) => {
    const c = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.parcelCredential.findFirstOrThrow({
        where: { parcelId, kind: 'holder' },
      }),
    );
    return tokens.secretOf(w.a.tenantId, c.id, c.attempt).code;
  };
  const refused = (res: Response) => {
    expect(res.status).toBe(403);
    expect(err(res).code).toBe('NO_OPEN_SHIFT');
  };

  it('a receipt while the shift ends: it waits for the end, then is refused', async () => {
    const leaving = await s.guardOnDuty(w.a);
    const home = await s.solo();
    const photoFileId = await s.photo(leaving.token);
    const res = await whileShiftEnds(leaving.shiftId, () =>
      call(w, 'POST', '/gate/parcels', {
        token: leaving.token,
        body: {
          unitCode: home.unitCode,
          carrier: 'dhl',
          pieces: 1,
          photoFileId,
        },
      }),
    );
    refused(res);
    expect(
      await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.parcel.count({
          where: { unitId: home.unitId },
        }),
      ),
    ).toBe(0);
  });

  it('a hand-over while the shift ends: it waits for the end, then is refused', async () => {
    const home = await s.solo();
    const { id } = await s.receive(home.unitCode);
    const code = await holderCode(id);
    const leaving = await s.guardOnDuty(w.a);
    const res = await whileShiftEnds(leaving.shiftId, () =>
      call(w, 'POST', `/gate/parcels/${id}/handover`, {
        token: leaving.token,
        body: { code },
      }),
    );
    refused(res);
    expect((await parcel(id)).status).toBe('held');
  });

  it('a return while the shift ends: it waits for the end, then is refused', async () => {
    const home = await s.solo();
    const { id } = await s.receive(home.unitCode);
    await call(w, 'POST', `/me/parcels/${id}/reject`, {
      token: home.owner.token,
      body: { reasonCode: 'other' },
    }).expect(200);
    const leaving = await s.guardOnDuty(w.a);
    const res = await whileShiftEnds(leaving.shiftId, () =>
      call(w, 'POST', `/gate/parcels/${id}/return`, { token: leaving.token }),
    );
    refused(res);
    expect((await parcel(id)).status).toBe('rejected');
  });
});
