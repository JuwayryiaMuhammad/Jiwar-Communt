import { RolesService } from '../../src/core/access/roles.service';
import { newId } from '../../src/core/common/uuid';
import { fileHelpers } from '../setup/files';
import { gateHelpers } from '../setup/gate';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { parcelHelpers } from '../setup/parcels';
import { call } from './request';
import { buildWorld, type World } from './world';

/**
 * The guard reaches the files routes only through `parcels.handle`
 * (ADR 0035), and that permission is restricted to the `parcel_photo`
 * purpose by `FilesService.mayUpload`; finalize, read and delete act on the
 * caller's own live file only (`FilesService.own`), and an attached file has
 * no owner. This is the coverage the guard's removed "403 as guard" matrix
 * rows used to give, and what they never proved: the purposes.
 */
describe('API v0 — the guard and the files routes (ADR 0029, 0035)', () => {
  let h: HttpHarness;
  let w: World;
  let f: ReturnType<typeof fileHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
    f = fileHelpers(h);
  }, 120_000);

  afterAll(() => h.close());

  const outcome = (res: { status: number; body: unknown }) => ({
    status: res.status,
    code: (res.body as { code?: string }).code,
  });
  const upload = (token: string, purpose: string, contentType: string) =>
    call(w, 'POST', '/files/uploads', {
      token,
      body: { purpose, contentType, size: 20 },
    });
  const finalize = (token: string, id: string) =>
    call(w, 'POST', `/files/${id}/finalize`, { token });
  const read = (token: string, id: string) =>
    call(w, 'GET', `/files/${id}`, { token });
  const remove = (token: string, id: string) =>
    call(w, 'DELETE', `/files/${id}`, { token });
  /** A second guard of A (no shift needed: the files are not the gate's). */
  async function guardToken() {
    const g = await gateHelpers(h).guard(w.a);
    return w.tokenFor(w.a, g.id, 'staff');
  }
  const row = (id: string) =>
    w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.storedFile.findUnique({ where: { id } }),
    );

  it('upload: refused for every purpose but parcel_photo, which is the positive control', async () => {
    const refused: [string, string][] = [
      ['worker_photo', 'image/png'],
      ['document', 'application/pdf'],
      ['resident_photo', 'image/png'],
      ['ticket_photo', 'image/png'],
    ];
    for (const [purpose, type] of refused) {
      const res = await upload(w.a.tokens.guard, purpose, type);
      expect([purpose, outcome(res)]).toEqual([
        purpose,
        { status: 403, code: 'FORBIDDEN' },
      ]);
    }
    // Nothing was recorded for the refused declarations.
    const guardRows = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.storedFile.findMany({
        where: { ownerAccountId: w.a.ids.guard },
        select: { purpose: true },
      }),
    );
    expect(guardRows.filter((r) => r.purpose !== 'parcel_photo')).toEqual([]);
    expect(
      outcome(await upload(w.a.tokens.guard, 'parcel_photo', 'image/jpeg')),
    ).toMatchObject({ status: 201 });
  });

  it('finalize, read and delete: another account’s file is not found, whoever owns it and whatever its purpose', async () => {
    // A resident's file, another guard's unattached parcel_photo.
    const resident = await f.ready(w.a.tokens.owner, 'ticket_photo');
    const otherGuard = await guardToken();
    const theirs = await f.ready(otherGuard, 'parcel_photo', 'image/jpeg');
    const pending = await f.uploaded(otherGuard, 'parcel_photo', 'image/jpeg');
    for (const id of [resident, theirs, pending]) {
      for (const [name, res] of [
        ['finalize', await finalize(w.a.tokens.guard, id)],
        ['read', await read(w.a.tokens.guard, id)],
        ['delete', await remove(w.a.tokens.guard, id)],
      ] as const)
        expect([name, outcome(res)]).toEqual([
          name,
          { status: 404, code: 'FILE_NOT_FOUND' },
        ]);
      // Untouched: still there, still its owner's.
      expect(await row(id)).toMatchObject({ deletedAt: null });
    }
    expect((await row(resident))?.status).toBe('ready');
    expect((await row(pending))?.status).toBe('pending');
    // The owner of the unattached photo still reads, finalizes and deletes it.
    expect((await read(otherGuard, theirs)).status).toBe(200);
    expect((await finalize(otherGuard, pending)).status).toBe(200);
    expect((await remove(otherGuard, theirs)).status).toBe(204);
  });

  it('an attached parcel_photo has no owner: not even the guard who took it reaches it', async () => {
    const guard = await parcelHelpers(h).guardOnDuty(w.a);
    const unit = await w.helpers.unit(w.a);
    const res = await parcelHelpers(h).receive(guard.token, unit.code);
    expect(res.status).toBe(201);
    const parcel = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.parcel.findUniqueOrThrow({
        where: { id: (res.body as { id: string }).id },
      }),
    );
    const id = parcel.photoFileId!;
    expect(await row(id)).toMatchObject({
      ownerAccountId: null,
      purpose: 'parcel_photo',
    });
    // The guard who received it, another guard, and the world's guard.
    const other = await parcelHelpers(h).guardOnDuty(w.a);
    for (const token of [guard.token, other.token, w.a.tokens.guard])
      for (const [name, r] of [
        ['finalize', await finalize(token, id)],
        ['read', await read(token, id)],
        ['delete', await remove(token, id)],
      ] as const)
        expect([name, outcome(r)]).toEqual([
          name,
          { status: 404, code: 'FILE_NOT_FOUND' },
        ]);
    expect(await row(id)).toMatchObject({ deletedAt: null });
  });

  it('a guard without parcels.handle is refused at the route on all four files routes', async () => {
    const c = await w.helpers.compound('Files guard');
    const g = await gateHelpers(h).guard(c);
    const token = await h.tokenFor({
      sub: g.id,
      tid: c.tenantId,
      typ: 'staff',
    });
    const roles = h.moduleRef.get(RolesService);
    const guardRole = (await w.helpers.asManager(c, () => roles.list())).find(
      (r) => r.key === 'guard',
    )!;
    expect(guardRole.permissions).toContain('parcels.handle');

    // With the permission: the guard uploads its parcel photo.
    expect(
      outcome(await upload(token, 'parcel_photo', 'image/jpeg')),
    ).toMatchObject({ status: 201 });

    // Without it: the guard role keeps the gate and nothing of the files.
    await w.helpers.asManager(c, () =>
      roles.replacePermissions(guardRole.id, ['gate.operate']),
    );
    const id = newId();
    for (const [name, res] of [
      ['upload', await upload(token, 'parcel_photo', 'image/jpeg')],
      ['finalize', await finalize(token, id)],
      ['read', await read(token, id)],
      ['delete', await remove(token, id)],
    ] as const)
      expect([name, outcome(res)]).toEqual([
        name,
        { status: 403, code: 'FORBIDDEN' },
      ]);
  });
});
