import { GlobalDbService } from '../../src/core/database/global-db.service';
import { FILES_SWEEP, objectKey } from '../../src/core/files/files.service';
import { ObjectStorage } from '../../src/core/files/object-storage';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import {
  PARCEL_REMINDER_SWEEP,
  PARCEL_RETENTION_DAYS,
  PARCEL_RETENTION_SWEEP,
} from '../../src/gate/parcels/parcel-sweeps';
import { ParcelTokens } from '../../src/gate/parcels/parcel-tokens';
import { call } from '../api/request';
import { buildWorld, type World } from '../api/world';
import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { parcelHelpers, parcelScenes } from '../setup/parcels';

const DAY = 86_400_000;

describe('Parcels — the sweeps (ADR 0035)', () => {
  let h: HttpHarness;
  let w: World;
  let s: ReturnType<typeof parcelScenes>;
  let sweep: SweepRunner;
  let storage: ObjectStorage;
  let tokens: ParcelTokens;
  /** The reminders of every other suite's parcels run too: ours is by id. */
  const later = (days: number, hours = 1) =>
    new Date(Date.now() + days * DAY + hours * 3_600_000);

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
    s = parcelScenes(w);
    sweep = h.moduleRef.get(SweepRunner);
    storage = h.moduleRef.get(ObjectStorage, { strict: false });
    tokens = h.moduleRef.get(ParcelTokens);
  }, 120_000);

  afterAll(() => h.close());

  const parcelRow = (id: string) =>
    w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.parcel.findUniqueOrThrow({ where: { id } }),
    );
  const notices = (accountId: string, kind: string, targetId: string) =>
    w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.notification.findMany({
        where: { accountId, kind, targetId },
      }),
    );
  const credentials = (parcelId: string) =>
    w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.parcelCredential.findMany({
        where: { parcelId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );

  /** Receives, with the holder code derived for the hand-over. */
  async function receiveWithCode(
    unitCode: string,
    over: Record<string, unknown> = {},
  ) {
    const parcel = await s.receive(unitCode, over);
    const holder = (await credentials(parcel.id))[0];
    return {
      ...parcel,
      code: tokens.secretOf(w.a.tenantId, holder.id, holder.attempt).code,
    };
  }
  const handOver = async (id: string, code: string, body: object = {}) => {
    const g = await s.guardOnDuty(w.a);
    const res = await call(w, 'POST', `/gate/parcels/${id}/handover`, {
      token: g.token,
      body: { code, ...body },
    });
    expect(res.status).toBe(200);
  };

  // --------------------------------------------------------------------------
  describe('reminders', () => {
    it('the residents are reminded once at the reminder days, the managers once at the manager days', async () => {
      const home = await s.household();
      const p = await s.receive(home.unitCode, { carrier: 'bosta', pieces: 2 });

      // Two days and 23 hours: not yet.
      await sweep.run(PARCEL_REMINDER_SWEEP, later(2, 23));
      expect((await parcelRow(p.id)).remindedAt).toBeNull();
      for (const who of [home.owner.id, home.member.id])
        expect(await notices(who, 'parcel.reminder', p.id)).toEqual([]);

      // Three days: the residents, once, with the carrier, the pieces, the
      // days and the unit — no name, no code.
      const at3 = later(3, 1);
      await sweep.run(PARCEL_REMINDER_SWEEP, at3);
      for (const who of [home.owner.id, home.member.id]) {
        const told = await notices(who, 'parcel.reminder', p.id);
        expect(told).toHaveLength(1);
        expect(told[0]).toMatchObject({
          priority: 'normal',
          targetType: 'parcel',
          params: {
            carrier: 'bosta',
            pieces: 2,
            days: 3,
            unitCode: home.unitCode,
          },
        });
      }
      expect((await parcelRow(p.id)).remindedAt).not.toBeNull();
      expect(await notices(w.a.ids.manager, 'parcel.held_long', p.id)).toEqual(
        [],
      );
      // Again, and a day later: nothing more.
      await sweep.run(PARCEL_REMINDER_SWEEP, at3);
      await sweep.run(PARCEL_REMINDER_SWEEP, later(4));
      expect(
        await notices(home.owner.id, 'parcel.reminder', p.id),
      ).toHaveLength(1);

      // Fourteen days: the managers, once.
      const at14 = later(14, 2);
      await sweep.run(PARCEL_REMINDER_SWEEP, at14);
      await sweep.run(PARCEL_REMINDER_SWEEP, at14);
      const told = await notices(w.a.ids.manager, 'parcel.held_long', p.id);
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({
        priority: 'normal',
        targetType: 'parcel',
        params: {
          parcelNumber: p.number,
          unitCode: home.unitCode,
          carrier: 'bosta',
          days: 14,
        },
      });
      const done = await parcelRow(p.id);
      expect(done.heldLongAt).not.toBeNull();
      // The residents were not reminded again, and the guard and the owner of
      // another unit were told nothing.
      expect(
        await notices(home.owner.id, 'parcel.reminder', p.id),
      ).toHaveLength(1);
      for (const who of [w.a.ids.guard, w.a.ids.tenant])
        expect(await notices(who, 'parcel.reminder', p.id)).toEqual([]);
      expect(JSON.stringify(told[0].params)).not.toMatch(/\b\d{6}\b/);
    });

    it('a parcel found at the manager days gets both notices, one each', async () => {
      const home = await s.solo();
      const p = await s.receive(home.unitCode);
      await sweep.run(PARCEL_REMINDER_SWEEP, later(20));
      expect(
        await notices(home.owner.id, 'parcel.reminder', p.id),
      ).toHaveLength(1);
      expect(
        await notices(w.a.ids.manager, 'parcel.held_long', p.id),
      ).toHaveLength(1);
      await sweep.run(PARCEL_REMINDER_SWEEP, later(40));
      expect(
        await notices(home.owner.id, 'parcel.reminder', p.id),
      ).toHaveLength(1);
      expect(
        await notices(w.a.ids.manager, 'parcel.held_long', p.id),
      ).toHaveLength(1);
    });

    it('only held parcels: handed over, rejected and returned ones are left alone', async () => {
      const home = await s.solo();
      const handed = await receiveWithCode(home.unitCode);
      await handOver(handed.id, handed.code);
      const rejected = await s.receive(home.unitCode);
      await call(w, 'POST', `/me/parcels/${rejected.id}/reject`, {
        token: home.owner.token,
        body: { reasonCode: 'other' },
      }).expect(200);
      await sweep.run(PARCEL_REMINDER_SWEEP, later(20));
      for (const p of [handed, rejected]) {
        const row = await parcelRow(p.id);
        expect([row.remindedAt, row.heldLongAt]).toEqual([null, null]);
        expect(await notices(home.owner.id, 'parcel.reminder', p.id)).toEqual(
          [],
        );
      }
    });

    it('follows the compound’s settings', async () => {
      const home = await s.solo();
      const p = await s.receive(home.unitCode);
      const patch = (body: object) =>
        call(w, 'PATCH', '/parcel-settings', {
          token: w.a.tokens.manager,
          body,
        });
      try {
        await patch({ parcelReminderDays: 1, parcelManagerDays: 2 }).expect(
          200,
        );
        await sweep.run(PARCEL_REMINDER_SWEEP, later(1, 2));
        expect(
          await notices(home.owner.id, 'parcel.reminder', p.id),
        ).toHaveLength(1);
        expect(
          await notices(w.a.ids.manager, 'parcel.held_long', p.id),
        ).toEqual([]);
        await sweep.run(PARCEL_REMINDER_SWEEP, later(2, 2));
        expect(
          await notices(w.a.ids.manager, 'parcel.held_long', p.id),
        ).toHaveLength(1);
      } finally {
        await patch({ parcelManagerDays: 14 });
        await patch({ parcelReminderDays: 3 });
      }
    });

    it('a unit nobody can collect for: marked reminded, nobody to tell, the managers were told on arrival', async () => {
      const vacant = await w.helpers.unit(w.a);
      const p = await s.receive(vacant.code);
      await sweep.run(PARCEL_REMINDER_SWEEP, later(4));
      expect((await parcelRow(p.id)).remindedAt).not.toBeNull();
      expect(
        await notices(w.a.ids.manager, 'parcel.unclaimable', p.id),
      ).toHaveLength(1);
      expect(await notices(w.a.ids.manager, 'parcel.reminder', p.id)).toEqual(
        [],
      );
    });
  });

  // --------------------------------------------------------------------------
  describe('retention', () => {
    /** A handed-over parcel with everything personal on it. */
    async function withEverything() {
      const home = await s.household();
      const p = await receiveWithCode(home.unitCode, {
        labelName: 'Layla Hassan',
      });
      await call(w, 'POST', `/me/parcels/${p.id}/delegate`, {
        token: home.owner.token,
        body: { name: 'Karim Adel' },
      }).expect(201);
      const delegate = (await credentials(p.id)).find(
        (c) => c.kind === 'delegate',
      )!;
      const code = tokens.secretOf(
        w.a.tenantId,
        delegate.id,
        delegate.attempt,
      ).code;
      // Handed to the delegate, with a photo of the hand-over.
      const g = await s.guardOnDuty(w.a);
      const res = await call(w, 'POST', `/gate/parcels/${p.id}/handover`, {
        token: g.token,
        body: { code, photoFileId: await s.photo(g.token) },
      });
      expect(res.status).toBe(200);
      return { home, p };
    }

    it('thirty days after the hand-over — and not a minute before — the names, the photos and the recipient go', async () => {
      const { p } = await withEverything();
      const before = await parcelRow(p.id);
      expect(before).toMatchObject({
        labelName: 'Layla Hassan',
        status: 'handed_over',
      });
      expect(before.photoFileId).not.toBeNull();
      expect(before.handoverPhotoFileId).not.toBeNull();
      const photoKey = objectKey({
        tenantId: w.a.tenantId,
        id: before.photoFileId!,
      });
      const handoverKey = objectKey({
        tenantId: w.a.tenantId,
        id: before.handoverPhotoFileId!,
      });
      expect(await storage.head(photoKey)).not.toBeNull();

      // 29 days 23 hours after it closed: everything is still there.
      const closed = before.closedAt!.getTime();
      await sweep.run(
        PARCEL_RETENTION_SWEEP,
        new Date(closed + PARCEL_RETENTION_DAYS * DAY - 3_600_000),
      );
      await sweep.run(FILES_SWEEP, new Date(closed + 29 * DAY));
      const kept = await parcelRow(p.id);
      expect(kept).toMatchObject({
        labelName: 'Layla Hassan',
        photoFileId: before.photoFileId,
        dataClearedAt: null,
      });
      expect(
        (await credentials(p.id)).find((c) => c.kind === 'delegate')!
          .delegateName,
      ).toBe('Karim Adel');
      expect(await storage.head(photoKey)).not.toBeNull();

      // At thirty days: cleared.
      const at30 = new Date(closed + PARCEL_RETENTION_DAYS * DAY);
      await sweep.run(PARCEL_RETENTION_SWEEP, at30);
      const gone = await parcelRow(p.id);
      expect(gone).toMatchObject({
        labelName: null,
        photoFileId: null,
        handoverPhotoFileId: null,
        handedToId: null,
        status: 'handed_over',
        handedOverMethod: 'delegate',
      });
      expect(gone.dataClearedAt).not.toBeNull();
      expect(
        (await credentials(p.id)).map((c) => [c.kind, c.delegateName]),
      ).toEqual([
        ['holder', null],
        ['delegate', null],
      ]);
      // The files are marked deleted, audited with the reason; the files
      // sweep removes the objects and then the rows.
      const files = await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.storedFile.findMany({
          where: {
            id: { in: [before.photoFileId!, before.handoverPhotoFileId!] },
          },
        }),
      );
      expect(files.every((f) => f.deletedAt !== null)).toBe(true);
      const audit = await auditReaders(h).tenant(w.a.tenantId, {
        action: 'file.deleted',
        targetId: before.photoFileId!,
      });
      expect(audit[0].metadata).toMatchObject({
        purpose: 'parcel_photo',
        reasonCode: 'retention',
      });
      await sweep.run(FILES_SWEEP);
      expect(await storage.head(photoKey)).toBeNull();
      expect(await storage.head(handoverKey)).toBeNull();
      expect(
        await w.helpers.asManager(w.a, () =>
          w.helpers.prisma.tenant.storedFile.count({
            where: {
              id: { in: [before.photoFileId!, before.handoverPhotoFileId!] },
            },
          }),
        ),
      ).toBe(0);
    });

    it('the parcel and its events stay, and a second run changes nothing', async () => {
      const { p } = await withEverything();
      const closed = (await parcelRow(p.id)).closedAt!.getTime();
      const at = new Date(closed + 31 * DAY);
      await sweep.run(PARCEL_RETENTION_SWEEP, at);
      const first = await parcelRow(p.id);
      await sweep.run(PARCEL_RETENTION_SWEEP, new Date(at.getTime() + DAY));
      expect(await parcelRow(p.id)).toEqual(first);
      const events = await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.parcelEvent.findMany({
          where: { parcelId: p.id },
        }),
      );
      expect(events.map((e) => e.kind).sort()).toEqual([
        'delegate_authorized',
        'handed_over',
        'received',
      ]);
    });

    it('a returned parcel is cleared 30 days after the return; a rejected one keeps its data until it is returned', async () => {
      const home = await s.solo();
      const rejected = await s.receive(home.unitCode, {
        labelName: 'Not Ours',
      });
      await call(w, 'POST', `/me/parcels/${rejected.id}/reject`, {
        token: home.owner.token,
        body: { reasonCode: 'not_ours' },
      }).expect(200);
      // Far in the future, yet never returned: nothing is cleared.
      await sweep.run(PARCEL_RETENTION_SWEEP, later(100));
      expect(await parcelRow(rejected.id)).toMatchObject({
        labelName: 'Not Ours',
        dataClearedAt: null,
      });
      const g = await s.guardOnDuty(w.a);
      await call(w, 'POST', `/gate/parcels/${rejected.id}/return`, {
        token: g.token,
      }).expect(200);
      const returnedAt = (await parcelRow(rejected.id)).returnedAt!;
      await sweep.run(
        PARCEL_RETENTION_SWEEP,
        new Date(returnedAt.getTime() + 29 * DAY),
      );
      expect((await parcelRow(rejected.id)).labelName).toBe('Not Ours');
      await sweep.run(
        PARCEL_RETENTION_SWEEP,
        new Date(returnedAt.getTime() + 30 * DAY),
      );
      expect(await parcelRow(rejected.id)).toMatchObject({
        labelName: null,
        photoFileId: null,
        status: 'returned',
      });
    });

    it('a parcel still held is never cleared', async () => {
      const home = await s.solo();
      const p = await s.receive(home.unitCode, { labelName: 'Still Here' });
      await sweep.run(PARCEL_RETENTION_SWEEP, later(500));
      expect(await parcelRow(p.id)).toMatchObject({
        labelName: 'Still Here',
        dataClearedAt: null,
      });
    });
  });

  // --------------------------------------------------------------------------
  describe('a suspended compound', () => {
    it('is told nothing, but its personal data is still deleted on time', async () => {
      const c = await w.helpers.compound('Parcels suspended');
      const unit = await w.helpers.unit(c);
      const owner = await w.helpers.resident(c, [unit.id]);
      const guard = await parcelHelpers(h).guardOnDuty(c);
      const received = async (labelName: string) => {
        const res = await parcelHelpers(h).receive(guard.token, unit.code, {
          labelName,
        });
        expect(res.status).toBe(201);
        return (res.body as { id: string }).id;
      };
      const closedId = await received('Closed One');
      const heldId = await received('Held One');
      const asC = <T>(fn: () => Promise<T>) => w.helpers.asManager(c, fn);
      const holder = await asC(() =>
        w.helpers.prisma.tenant.parcelCredential.findFirstOrThrow({
          where: { parcelId: closedId },
        }),
      );
      const code = tokens.secretOf(c.tenantId, holder.id, holder.attempt).code;
      const handed = await call(
        w,
        'POST',
        `/gate/parcels/${closedId}/handover`,
        {
          token: guard.token,
          body: { code },
        },
      );
      expect(handed.status).toBe(200);
      const closedAt = (
        await asC(() =>
          w.helpers.prisma.tenant.parcel.findUniqueOrThrow({
            where: { id: closedId },
          }),
        )
      ).closedAt!;

      await h.suspendTenant(c.tenantId);
      const at = new Date(closedAt.getTime() + 31 * DAY);
      await sweep.run(PARCEL_REMINDER_SWEEP, at);
      await sweep.run(PARCEL_RETENTION_SWEEP, at);

      // Nobody is told while it is locked down ...
      const held = await asC(() =>
        w.helpers.prisma.tenant.parcel.findUniqueOrThrow({
          where: { id: heldId },
        }),
      );
      expect([held.remindedAt, held.heldLongAt]).toEqual([null, null]);
      expect(
        await asC(() =>
          w.helpers.prisma.tenant.notification.count({
            where: { accountId: owner.id, kind: 'parcel.reminder' },
          }),
        ),
      ).toBe(0);
      // ... but the data of what was closed is deleted, like visitor data.
      const cleared = await asC(() =>
        w.helpers.prisma.tenant.parcel.findUniqueOrThrow({
          where: { id: closedId },
        }),
      );
      expect(cleared).toMatchObject({ labelName: null, photoFileId: null });
      expect(cleared.dataClearedAt).not.toBeNull();
      // The held one's data stays: it is not closed.
      expect(held.labelName).toBe('Held One');

      // Reactivated, the reminders resume.
      await h.moduleRef.get(GlobalDbService).tenant.update({
        where: { id: c.tenantId },
        data: { status: 'active' },
      });
      await sweep.run(PARCEL_REMINDER_SWEEP, at);
      expect(
        (
          await asC(() =>
            w.helpers.prisma.tenant.parcel.findUniqueOrThrow({
              where: { id: heldId },
            }),
          )
        ).remindedAt,
      ).not.toBeNull();
    });
  });
});
