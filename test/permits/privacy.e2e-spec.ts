import { HouseholdsService } from '../../src/community/households/households.service';
import { MemberPermissionsService } from '../../src/community/households/member-permissions.service';
import { ResidentsService } from '../../src/community/residents/residents.service';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import { PEOPLE_DATA_SWEEP } from '../../src/gate/permits/permit-sweeps';
import { eraseNow } from '../setup/erasure';
import { buildExports, readArchive, stepUp } from '../setup/exports';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  day,
  permitHelpers,
  type PermitBody,
  type PermitSetUp,
  type Who,
} from '../setup/permits';
import { leakText } from '../setup/leak-text';

// eslint-disable-next-line no-restricted-syntax -- a real 24 h: the people-data purge measures from the permit's end, in ms
const DAY = 86_400_000;

describe('Permits — privacy (ADR 0049)', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  /** A home with a primary who has an email, and a member who may invite. */
  async function household(name: string) {
    const c = await p.setUp(name);
    const created = await p.v.x.resident(c.c, [c.home.id]);
    // `alice` is the home's first resident and its primary; `bob` lives
    // there too.
    const bob = {
      ...(await p.who(c.c, created.id, 'resident')),
      email: created.email,
    };
    const joined = await p.v.x.joinFamily(c.c, c.home.id, c.alice);
    const member = {
      ...(await p.who(c.c, joined.accountId, 'family')),
      memberId: joined.memberId,
      email: joined.email,
    };
    await p.v.x.as(c.c, { id: c.alice.id, type: 'resident' }, () =>
      h.moduleRef
        .get(MemberPermissionsService)
        .grant(joined.memberId, 'visitors_invite'),
    );
    return { ...c, bob, member };
  }

  const cancelled = async (c: PermitSetUp, id: string) =>
    p.row(c.c, id).then((r) => ({
      status: r.status,
      cancelSide: r.cancelSide,
      cancelReason: r.cancelReason,
    }));

  describe('the requester goes', () => {
    it('a member removed: their live event is cancelled by the system and the primary told', async () => {
      const c = await household('Privacy Removed Court');
      const event = await p.event(c.member, c.home.id, 3);
      const mine = await p.works(c.alice, c.home.id);
      await p.v.x.as(c.c, { id: c.alice.id, type: 'resident' }, () =>
        h.moduleRef.get(HouseholdsService).removeMember(c.member.memberId, {
          code: 'relation_ended',
          text: 'No longer',
        }),
      );
      expect(await cancelled(c, event.id)).toEqual({
        status: 'cancelled',
        cancelSide: 'system',
        cancelReason: 'requester_left',
      });
      expect((await p.row(c.c, mine.id)).status).toBe('pending');
      expect(await p.told(c.c, c.alice.id, event.id)).toEqual([
        {
          kind: 'unit_permit.cancelled',
          params: { permitKind: 'event', reason: 'requester_left' },
        },
      ]);
    });

    it('deactivated: every live permit they asked for; an ended one stays as it was', async () => {
      const c = await household('Privacy Deactivated Court');
      await p.anyTime(c.manager);
      const live = await p.works(c.alice, c.home.id);
      const done = await p.works(c.alice, c.home.id);
      await p
        .decide(c.manager, done.id, 'reject', { reasonCode: 'other' })
        .expect(200);
      await p.v.x.asManager(c.c, () =>
        h.moduleRef
          .get(AccountsService)
          .updateStatus(c.alice.id, { status: 'inactive' }),
      );
      expect(await cancelled(c, live.id)).toMatchObject({
        status: 'cancelled',
        cancelReason: 'requester_left',
      });
      expect((await p.row(c.c, done.id)).status).toBe('rejected');
      // The one who left is not told about their own permit.
      expect(
        (await p.told(c.c, c.alice.id, live.id)).map((n) => n.kind),
      ).not.toContain('unit_permit.cancelled');
    });

    it('losing only the primary role keeps them: the work is the unit’s', async () => {
      const c = await household('Privacy Primary Court');
      const permit = await p.works(c.alice, c.home.id);
      await p.v.x.asManager(c.c, () =>
        h.moduleRef.get(ResidentsService).setPrimary(c.home.id, c.bob.id),
      );
      expect((await p.row(c.c, permit.id)).status).toBe('pending');
      // The new primary sees it and may cancel it.
      expect((await p.get(c.bob, permit.id)).mine).toBe(false);
      await p
        .http('post', `/permits/${permit.id}/cancel`, c.bob.token, {})
        .expect(200);
    });
  });

  describe('erasure', () => {
    it('what the resident wrote and their photo go, once; the management’s notes and the rows stay', async () => {
      const c = await household('Privacy Erased Court');
      await p.anyTime(c.manager);
      const mine = await p.works(c.alice, c.home.id, {
        contractorCompany: 'PRIV-COMPANY',
        description: 'PRIV-DESCRIPTION',
      });
      await p
        .decide(c.manager, mine.id, 'approve', { note: 'PRIV-STAFF-NOTE' })
        .expect(200);
      const photo = await p.files.ready(c.alice.token, 'permit_photo');
      const exit = await p.exit(c.alice, c.home.id, {
        photoFileId: photo,
        items: [{ name: 'PRIV-ITEM', quantity: 1 }],
      });
      const move = await p.move(c.alice, c.home.id, {
        itemsDescription: 'PRIV-ITEMS',
      });
      const event = await p.event(c.alice, c.home.id, 2, {
        title: 'PRIV-TITLE',
      });
      // A primary's erasure waits for another primary (ADR 0023).
      await p.v.x.asManager(c.c, () =>
        h.moduleRef.get(ResidentsService).setPrimary(c.home.id, c.bob.id),
      );
      await eraseNow(h, c.c, c.alice.id);
      for (const id of [mine.id, exit.id, move.id, event.id]) {
        const row = await p.row(c.c, id);
        expect(row).toMatchObject({
          contractorCompany: null,
          description: null,
          itemsDescription: null,
          items: null,
          title: null,
          photoFileId: null,
        });
        expect(row.textClearedAt).not.toBeNull();
      }
      expect((await p.row(c.c, mine.id)).staffNote).toBe('PRIV-STAFF-NOTE');
      const file = await p.v.inTx(c.c, (tx) =>
        tx.storedFile.findUniqueOrThrow({ where: { id: photo } }),
      );
      expect(file.deletedAt).not.toBeNull();
      const audit = await p.v.x.asManager(c.c, () =>
        p.v.x.prisma.tenant.auditLog.findMany({
          where: { action: 'unit_permit.text_cleared', targetId: exit.id },
        }),
      );
      expect(audit.map((a) => a.metadata)).toEqual([
        {
          kind: 'material_exit',
          contractorCompany: false,
          description: false,
          itemsDescription: false,
          items: true,
          title: false,
          photo: true,
        },
      ]);
      expect(JSON.stringify(audit)).not.toContain('PRIV-');
    });
  });

  describe('the purge, 30 days after the end', () => {
    it('workers’ names, faces and ID hashes, guests’ names and plates, the truck’s plate and the goods’ photo; the gate log stays (L3)', async () => {
      const c = await household('Privacy Purge Court');
      await p.anyTime(c.manager);
      const works = await p.works(c.alice, c.home.id, {
        startsOn: day(0),
        endsOn: day(0),
      });
      const { worker } = await p.addWorker(c.alice, works.id, {
        fullName: 'PURGE-WORKER-NAME',
      });
      const workerRow = await p.v.inTx(c.c, (tx) =>
        tx.permitWorker.findUniqueOrThrow({ where: { id: worker.id } }),
      );
      const event = await p.event(c.alice, c.home.id, 1, {
        guests: [{ fullName: 'PURGE-GUEST-NAME', vehiclePlate: 'PRG 1' }],
      });
      const move = await p.move(c.alice, c.home.id, {
        date: day(0),
        window: { from: '00:00', to: '23:59' },
        truckPlate: 'PRG 2',
      });
      const photo = await p.files.ready(c.alice.token, 'permit_photo');
      const exit = await p.exit(c.alice, c.home.id, {
        validFrom: day(0),
        validUntil: day(0),
        photoFileId: photo,
      });
      const sweep = (now: Date) => p.sweep(PEOPLE_DATA_SWEEP, now);
      const after = (days: number) => new Date(Date.now() + days * DAY);
      // 29 days after the last end: nothing yet.
      await sweep(after(1 + 29));
      expect(
        (
          await p.v.inTx(c.c, (tx) =>
            tx.permitWorker.findUniqueOrThrow({ where: { id: worker.id } }),
          )
        ).purgedAt,
      ).toBeNull();
      await sweep(after(4 + 31));
      const purgedWorker = await p.v.inTx(c.c, (tx) =>
        tx.permitWorker.findUniqueOrThrow({ where: { id: worker.id } }),
      );
      expect(purgedWorker).toMatchObject({
        fullName: null,
        photoFileId: null,
        idLast4Hash: null,
      });
      expect(purgedWorker.purgedAt).not.toBeNull();
      const guest = await p.v.inTx(c.c, (tx) =>
        tx.permitGuest.findFirstOrThrow({ where: { permitId: event.id } }),
      );
      expect(guest).toMatchObject({ fullName: null, vehiclePlate: null });
      expect((await p.row(c.c, move.id)).truckPlate).toBeNull();
      expect((await p.row(c.c, exit.id)).photoFileId).toBeNull();
      for (const id of [workerRow.photoFileId!, photo]) {
        const f = await p.v.inTx(c.c, (tx) =>
          tx.storedFile.findUniqueOrThrow({ where: { id } }),
        );
        expect(f.deletedAt).not.toBeNull();
      }
      // Nothing of them is left in the permits' tables, the audit or the
      // notifications.
      const scan = await p.v.inTx(c.c, (tx) =>
        tx.$queryRawUnsafe<{ hit: string }[]>(
          `SELECT 'unit_permits' AS hit FROM unit_permits t WHERE t::text ~ '(PURGE-|PRG )'
           UNION ALL SELECT 'permit_workers' FROM permit_workers t WHERE t::text ~ '(PURGE-|PRG )'
           UNION ALL SELECT 'permit_guests' FROM permit_guests t WHERE t::text ~ '(PURGE-|PRG )'
           UNION ALL SELECT 'audit_log' FROM audit_log t WHERE t::text ~ '(PURGE-|PRG )'
           UNION ALL SELECT 'notifications' FROM notifications t WHERE t::text ~ '(PURGE-|PRG )'`,
        ),
      );
      expect(scan).toEqual([]);
      const audit = await p.v.x.asManager(c.c, () =>
        p.v.x.prisma.tenant.auditLog.findMany({
          where: { action: 'unit_permit.data_purged', targetId: works.id },
        }),
      );
      expect(audit.map((a) => a.metadata)).toEqual([
        {
          kind: 'works',
          workers: 1,
          guests: 0,
          truckPlate: false,
          photo: false,
        },
      ]);
      // Purged once.
      await sweep(after(4 + 32));
      expect(
        await p.v.x.asManager(c.c, () =>
          p.v.x.prisma.tenant.auditLog.count({
            where: { action: 'unit_permit.data_purged', targetId: works.id },
          }),
        ),
      ).toBe(1);
    });
  });

  describe('export', () => {
    async function exportOf(who: Who & { email: string }) {
      await stepUp(h, who.token, who.email);
      const asked = await p
        .http('post', '/me/data-exports', who.token, {})
        .expect(201);
      await buildExports(h);
      const dl = await p
        .http(
          'get',
          `/me/data-exports/${(asked.body as { id: string }).id}/download`,
          who.token,
        )
        .expect(200);
      return readArchive((dl.body as { url: string }).url);
    }

    it('the account’s own permits with its workers and guests while they last; never the last four, a photo, the staff’s note or another’s permit (L6)', async () => {
      const c = await household('Privacy Export Court');
      await p.anyTime(c.manager);
      const theirs = await p.works(c.alice, c.home.id, {
        description: 'Alice-only words',
      });
      const event = await p.event(c.member, c.home.id, 1, {
        guests: [{ fullName: 'Export Guest', vehiclePlate: 'EXP 9' }],
      });
      await p
        .decide(c.manager, theirs.id, 'approve', { note: 'EXPORT-STAFF' })
        .expect(200);
      const archive = await exportOf(c.member);
      expect(archive.names).toContain('permits/permits.json');
      const permits = JSON.parse(
        archive.text('permits/permits.json'),
      ) as PermitBody[];
      expect(permits).toEqual([
        expect.objectContaining({
          reference: event.reference,
          kind: 'event',
          event: expect.objectContaining({
            guests: [
              expect.objectContaining({
                fullName: 'Export Guest',
                vehiclePlate: 'EXP 9',
              }),
            ],
          }) as object,
        }),
      ]);
      const text = archive.text('permits/permits.json');
      expect(text).not.toContain('Alice-only words');
      expect(text).not.toContain('EXPORT-STAFF');
      // The primary's own, with a worker: names, never the last four.
      const works = await p.works(c.alice, c.home.id);
      await p.addWorker(c.alice, works.id, {
        fullName: 'Export Worker',
        idLast4: '6157',
      });
      const created = await p.v.inTx(c.c, (tx) =>
        tx.account.findUniqueOrThrow({ where: { id: c.alice.id } }),
      );
      const aliceArchive = await exportOf({
        ...c.alice,
        email: created.email!,
      });
      const aliceText = aliceArchive.text('permits/permits.json');
      expect(aliceText).toContain('Export Worker');
      expect(leakText(aliceText)).not.toContain('6157');
      expect(aliceText).not.toContain('EXPORT-STAFF');
      expect(aliceText).not.toMatch(/"url"|idLast4Hash|staffNote/);
    });
  });
});
