import { newId } from '../../src/core/common/uuid';
import { ParcelTokens } from '../../src/gate/parcels/parcel-tokens';
import { keyPaths, listKeys } from '../api/keys';
import { call, err } from '../api/request';
import { buildWorld, type World } from '../api/world';
import { auditReaders } from '../setup/audit';
import { fileHelpers } from '../setup/files';
import { gateHelpers } from '../setup/gate';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { parcelHelpers } from '../setup/parcels';

const GATE_PARCEL = [
  'carrier',
  'handedOverAt',
  'hasPhoto',
  'id',
  'number',
  'pieces',
  'receivedAt',
  'rejectedAt',
  'returnedAt',
  'status',
  'unitCode',
];

describe('Parcels — receiving at the gate (ADR 0035)', () => {
  let h: HttpHarness;
  let w: World;
  let p: ReturnType<typeof parcelHelpers>;
  let homeCode: string;
  let rentedCode: string;

  const asManager = <T>(fn: () => Promise<T>) => w.helpers.asManager(w.a, fn);
  const parcelRow = (id: string) =>
    asManager(() =>
      w.helpers.prisma.tenant.parcel.findUniqueOrThrow({ where: { id } }),
    );
  const unitCodeOf = async (unitId: string) =>
    (
      await asManager(() =>
        w.helpers.prisma.tenant.unit.findUniqueOrThrow({
          where: { id: unitId },
        }),
      )
    ).code;
  const notificationsOf = (accountId: string, kind: string) =>
    asManager(() =>
      w.helpers.prisma.tenant.notification.findMany({
        where: { accountId, kind },
        orderBy: { createdAt: 'asc' },
      }),
    );

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
    p = parcelHelpers(h);
    homeCode = await unitCodeOf(w.a.homeUnitId);
    rentedCode = await unitCodeOf(w.a.rentedUnitId);
  }, 120_000);

  afterAll(() => h.close());

  describe('POST /gate/parcels', () => {
    it('logs a parcel: the guard’s view carries no label, no resident and no code', async () => {
      const res = await p.receive(w.a.tokens.guard, homeCode, {
        carrier: 'aramex',
        pieces: 3,
        labelName: 'Layla Hassan',
      });
      expect(res.status).toBe(201);
      expect(keyPaths(res.body)).toEqual(GATE_PARCEL);
      expect(res.body).toMatchObject({
        unitCode: homeCode,
        carrier: 'aramex',
        pieces: 3,
        status: 'held',
        handedOverAt: null,
        rejectedAt: null,
        returnedAt: null,
        hasPhoto: true,
      });
      expect(JSON.stringify(res.body)).not.toContain('Layla');
      expect(JSON.stringify(res.body)).not.toMatch(/\b\d{6}\b/);

      // The label is on the row, for the residents; the photo moved to it.
      const row = await parcelRow((res.body as { id: string }).id);
      expect(row).toMatchObject({
        labelName: 'Layla Hassan',
        unitId: w.a.homeUnitId,
        gateId: w.a.gateId,
        shiftId: w.a.shiftId,
        receivedById: w.a.ids.guard,
        status: 'held',
      });
      const file = await asManager(() =>
        w.helpers.prisma.tenant.storedFile.findUniqueOrThrow({
          where: { id: row.photoFileId! },
        }),
      );
      expect(file).toMatchObject({
        purpose: 'parcel_photo',
        ownerAccountId: null,
      });
      expect(file.attachedAt).not.toBeNull();
    });

    it('the numbers count up, one per parcel, whatever the unit', async () => {
      const a = await p.receive(w.a.tokens.guard, homeCode);
      const b = await p.receive(w.a.tokens.guard, rentedCode);
      const n = (r: { body: unknown }) => (r.body as { number: number }).number;
      expect(n(b)).toBe(n(a) + 1);
    });

    it('stores only the HMACs of the code and the QR, and they are the derived ones', async () => {
      const res = await p.receive(w.a.tokens.guard, homeCode);
      const id = (res.body as { id: string }).id;
      const credentials = await asManager(() =>
        w.helpers.prisma.tenant.parcelCredential.findMany({
          where: { parcelId: id },
        }),
      );
      expect(credentials).toHaveLength(1);
      const [c] = credentials;
      expect(c).toMatchObject({
        kind: 'holder',
        createdById: w.a.ids.guard,
        delegateName: null,
        endedAt: null,
      });
      expect(c.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(c.qrTokenHash).toMatch(/^[0-9a-f]{64}$/);
      const secret = h.moduleRef
        .get(ParcelTokens)
        .secretOf(w.a.tenantId, c.id, c.attempt);
      expect(c.codeHash).toBe(secret.codeHash);
      expect(c.qrTokenHash).toBe(secret.qrTokenHash);
      // Nothing in the row can show the code or the token.
      expect(JSON.stringify(c)).not.toContain(secret.code);
      expect(JSON.stringify(c)).not.toContain(secret.token);
      // Another compound's hash of the same code is another hash.
      expect(
        h.moduleRef.get(ParcelTokens).codeHashOf(w.b.tenantId, secret.code),
      ).not.toBe(c.codeHash);
    });

    it('tells the unit’s residing adults: the primary and a member, not a landlord', async () => {
      const home = await p.receive(w.a.tokens.guard, homeCode, {
        carrier: 'noon',
        pieces: 4,
        labelName: 'PII-LABEL-name',
      });
      const homeId = (home.body as { id: string }).id;
      for (const who of ['owner', 'family'] as const) {
        const [n] = (
          await notificationsOf(w.a.ids[who], 'parcel.arrived')
        ).slice(-1);
        expect(n).toMatchObject({
          kind: 'parcel.arrived',
          priority: 'normal',
          targetType: 'parcel',
          targetId: homeId,
        });
        expect(n.params).toEqual({
          carrier: 'noon',
          pieces: 4,
          receivedAt: expect.any(String) as string,
          unitCode: homeCode,
        });
        // No name, no code.
        expect(JSON.stringify(n.params)).not.toContain('PII-LABEL');
      }

      const rented = await p.receive(w.a.tokens.guard, rentedCode);
      const rentedId = (rented.body as { id: string }).id;
      expect(
        (await notificationsOf(w.a.ids.tenant, 'parcel.arrived')).map(
          (n) => n.targetId,
        ),
      ).toContain(rentedId);
      // A landlord who does not live there is not told, nor the other unit's.
      expect(
        (await notificationsOf(w.a.ids.landlord, 'parcel.arrived')).map(
          (n) => n.targetId,
        ),
      ).not.toContain(rentedId);
      expect(
        (await notificationsOf(w.a.ids.tenant, 'parcel.arrived')).map(
          (n) => n.targetId,
        ),
      ).not.toContain(homeId);
      // The guard and the manager are not told a parcel arrived either.
      for (const who of ['guard', 'manager'] as const)
        expect(
          (await notificationsOf(w.a.ids[who], 'parcel.arrived')).map(
            (n) => n.targetId,
          ),
        ).not.toContain(homeId);
    });

    it('a unit nobody can collect for: the managers are told at once, once; the guard sees nothing different', async () => {
      const vacant = await w.helpers.unit(w.a);
      const code = await unitCodeOf(vacant.id);
      const before = (
        await notificationsOf(w.a.ids.manager, 'parcel.unclaimable')
      ).length;
      const res = await p.receive(w.a.tokens.guard, code, { carrier: 'ups' });
      expect(res.status).toBe(201);
      // The same answer as for an occupied unit.
      expect(keyPaths(res.body)).toEqual(GATE_PARCEL);
      const id = (res.body as { id: string; number: number }).id;
      const row = await parcelRow(id);
      expect(row.unclaimableAt).not.toBeNull();

      const told = await notificationsOf(w.a.ids.manager, 'parcel.unclaimable');
      expect(told).toHaveLength(before + 1);
      expect(told[told.length - 1]).toMatchObject({
        priority: 'normal',
        targetType: 'parcel',
        targetId: id,
        params: { parcelNumber: row.number, unitCode: code, carrier: 'ups' },
      });
      // Nobody else is told: not the guard, not a resident.
      for (const who of ['guard', 'owner', 'tenant'] as const)
        expect(
          await notificationsOf(w.a.ids[who], 'parcel.unclaimable'),
        ).toEqual([]);
      // An occupied unit never tells the managers.
      const occupied = await p.receive(w.a.tokens.guard, homeCode);
      expect(
        (await notificationsOf(w.a.ids.manager, 'parcel.unclaimable')).map(
          (n) => n.targetId,
        ),
      ).not.toContain((occupied.body as { id: string }).id);
      // Once per parcel: a second parcel is told on its own.
      await p.receive(w.a.tokens.guard, code);
      expect(
        await notificationsOf(w.a.ids.manager, 'parcel.unclaimable'),
      ).toHaveLength(before + 2);
    });

    it('Idempotency-Key: a retry records one parcel and answers the same', async () => {
      const photoFileId = await p.photo(w.a.tokens.guard);
      const send = () =>
        call(w, 'POST', '/gate/parcels', {
          token: w.a.tokens.guard,
          body: {
            unitCode: homeCode,
            carrier: 'fedex',
            pieces: 1,
            photoFileId,
          },
        }).set('Idempotency-Key', `parcel-${photoFileId}`);
      const first = await send();
      expect(first.status).toBe(201);
      const again = await send();
      expect(again.status).toBe(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body).toEqual(first.body);
      const rows = await asManager(() =>
        w.helpers.prisma.tenant.parcel.count({ where: { photoFileId } }),
      );
      expect(rows).toBe(1);
      // The same key for another request is a conflict.
      const other = await call(w, 'POST', '/gate/parcels', {
        token: w.a.tokens.guard,
        body: { unitCode: homeCode, carrier: 'ups', pieces: 1, photoFileId },
      }).set('Idempotency-Key', `parcel-${photoFileId}`);
      expect(other.status).toBe(409);
      expect(err(other).code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('an unknown unit, another compound’s unit: UNIT_NOT_FOUND, the same answer', async () => {
      for (const unitCode of ['NO-SUCH-UNIT', w.bUnitCode]) {
        const res = await p.receive(w.a.tokens.guard, unitCode);
        expect({ status: res.status, code: err(res).code }).toEqual({
          status: 404,
          code: 'UNIT_NOT_FOUND',
        });
      }
    });

    it('the photo must be the guard’s own finalized parcel_photo, used once', async () => {
      const bad = async (photoFileId: string) => {
        const res = await call(w, 'POST', '/gate/parcels', {
          token: w.a.tokens.guard,
          body: { unitCode: homeCode, carrier: 'dhl', pieces: 1, photoFileId },
        });
        expect({
          status: res.status,
          code: err(res).code,
          fields: err(res).fields,
        }).toEqual({
          status: 400,
          code: 'VALIDATION_FAILED',
          fields: [{ field: 'photoFileId', code: 'FILE_NOT_AVAILABLE' }],
        });
      };
      await bad(newId());
      // Another purpose (and owner), another guard's file, another compound's file.
      await bad(await fileHelpers(h).ready(w.a.tokens.owner, 'ticket_photo'));
      await bad(await p.photo((await p.guardOnDuty(w.a)).token));
      await bad(w.bFileId);
      // Not finalized yet.
      await bad(
        await fileHelpers(h).uploaded(
          w.a.tokens.guard,
          'parcel_photo',
          'image/jpeg',
        ),
      );
      // Used once: the second parcel cannot take it.
      const photoFileId = await p.photo(w.a.tokens.guard);
      const ok = await call(w, 'POST', '/gate/parcels', {
        token: w.a.tokens.guard,
        body: { unitCode: homeCode, carrier: 'dhl', pieces: 1, photoFileId },
      });
      expect(ok.status).toBe(201);
      await bad(photoFileId);
    });

    it('a guard off shift acts on nothing: NO_OPEN_SHIFT', async () => {
      const g = await gateHelpers(h).guard(w.a);
      const token = await w.tokenFor(w.a, g.id, 'staff');
      const photoFileId = await p.photo(token);
      for (const res of [
        await call(w, 'POST', '/gate/parcels', {
          token,
          body: { unitCode: homeCode, carrier: 'dhl', pieces: 1, photoFileId },
        }),
        await call(w, 'GET', '/gate/parcels', { token }),
        await call(w, 'GET', `/gate/parcels/${w.bParcelId}`, { token }),
      ])
        expect({ status: res.status, code: err(res).code }).toEqual({
          status: 403,
          code: 'NO_OPEN_SHIFT',
        });
    });

    it('only a guard may: a resident, a family member and a manager are refused', async () => {
      for (const token of [
        w.a.tokens.owner,
        w.a.tokens.family,
        w.a.tokens.manager,
        w.a.tokens.technician,
      ]) {
        const res = await call(w, 'POST', '/gate/parcels', {
          token,
          body: {
            unitCode: homeCode,
            carrier: 'dhl',
            pieces: 1,
            photoFileId: newId(),
          },
        });
        expect({ status: res.status, code: err(res).code }).toEqual({
          status: 403,
          code: 'FORBIDDEN',
        });
      }
    });

    it('many guards at once: numbers and codes are all distinct', async () => {
      const guards = [
        await p.guardOnDuty(w.a),
        await p.guardOnDuty(w.a),
        await p.guardOnDuty(w.a),
      ];
      const results = await Promise.all(
        Array.from({ length: 9 }, (_, i) =>
          p.receive(guards[i % 3].token, i % 2 ? homeCode : rentedCode),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(9).fill(201));
      const ids = results.map((r) => (r.body as { id: string }).id);
      const numbers = results.map((r) => (r.body as { number: number }).number);
      expect(new Set(numbers).size).toBe(9);
      const credentials = await asManager(() =>
        w.helpers.prisma.tenant.parcelCredential.findMany({
          where: { parcelId: { in: ids } },
        }),
      );
      expect(new Set(credentials.map((c) => c.codeHash)).size).toBe(9);
    });
  });

  describe('GET /gate/parcels', () => {
    it('lists what needs doing, newest first, with the same view; filters and pages', async () => {
      const unit = await w.helpers.unit(w.a);
      const code = await unitCodeOf(unit.id);
      const made: string[] = [];
      for (let i = 0; i < 3; i++)
        made.push(
          (
            (await p.receive(w.a.tokens.guard, code, { pieces: i + 1 }))
              .body as {
              id: string;
            }
          ).id,
        );
      const list = await call(w, 'GET', '/gate/parcels', {
        token: w.a.tokens.guard,
        query: { unitCode: code },
      });
      expect(list.status).toBe(200);
      expect(keyPaths(list.body)).toEqual(listKeys(GATE_PARCEL));
      expect(
        (list.body as { data: { id: string }[] }).data.map((x) => x.id),
      ).toEqual([...made].reverse());

      const page1 = await call(w, 'GET', '/gate/parcels', {
        token: w.a.tokens.guard,
        query: { unitCode: code, limit: '2' },
      });
      const first = page1.body as {
        data: { id: string }[];
        nextCursor: string | null;
      };
      expect(first.data.map((x) => x.id)).toEqual([made[2], made[1]]);
      expect(first.nextCursor).not.toBeNull();
      const page2 = await call(w, 'GET', '/gate/parcels', {
        token: w.a.tokens.guard,
        query: { unitCode: code, limit: '2', cursor: first.nextCursor! },
      });
      expect(
        (page2.body as { data: { id: string }[] }).data.map((x) => x.id),
      ).toEqual([made[0]]);

      // Nothing is held for another status; an unknown unit is just empty.
      for (const query of [
        { unitCode: code, status: 'handed_over' },
        { unitCode: 'NO-SUCH-UNIT' },
        { unitCode: w.bUnitCode },
      ] as Record<string, string>[])
        expect(
          (
            await call(w, 'GET', '/gate/parcels', {
              token: w.a.tokens.guard,
              query,
            })
          ).body,
        ).toEqual({ data: [], nextCursor: null });
      // Another compound's parcels are never in it.
      const all = await call(w, 'GET', '/gate/parcels', {
        token: w.a.tokens.guard,
        query: { limit: '100' },
      });
      expect(JSON.stringify(all.body)).not.toContain(w.bParcelId);
    });
  });

  describe('GET /gate/parcels/{id}', () => {
    it('the photo as a short-lived URL, the history by side, no-store, never the label', async () => {
      const res = await p.receive(w.a.tokens.guard, homeCode, {
        labelName: 'PII-DETAIL-label',
      });
      const id = (res.body as { id: string }).id;
      const detail = await call(w, 'GET', `/gate/parcels/${id}`, {
        token: w.a.tokens.guard,
      });
      expect(detail.status).toBe(200);
      expect(detail.headers['cache-control']).toBe('no-store');
      expect(keyPaths(detail.body)).toEqual(
        [
          ...GATE_PARCEL,
          'events',
          'events[].actorSide',
          'events[].at',
          'events[].kind',
          'events[].method',
          'events[].reasonCode',
          'handoverPhoto',
          'photo',
          'photo.expiresAt',
          'photo.url',
        ].sort(),
      );
      const body = detail.body as {
        photo: { url: string };
        handoverPhoto: unknown;
        events: object[];
      };
      const row = await parcelRow(id);
      expect(body.photo.url).toContain(`t/${w.a.tenantId}/${row.photoFileId}`);
      expect(body.handoverPhoto).toBeNull();
      expect(body.events).toEqual([
        {
          kind: 'received',
          actorSide: 'guard',
          method: null,
          reasonCode: null,
          at: expect.any(String) as string,
        },
      ]);
      expect(detail.text).not.toContain('PII-DETAIL-label');
      expect(detail.text).not.toContain(w.a.ids.guard);
    });
  });

  describe('audit', () => {
    it('parcel.received: ids, carrier, pieces and the number — never a name, a code or a file', async () => {
      const res = await p.receive(w.a.tokens.guard, homeCode, {
        carrier: 'jumia',
        pieces: 5,
        labelName: 'PII-AUDIT-label',
      });
      const id = (res.body as { id: string }).id;
      const rows = await auditReaders(h).tenant(w.a.tenantId, {
        action: 'parcel.received',
        targetId: id,
      });
      expect(rows).toHaveLength(1);
      const row = await parcelRow(id);
      expect(rows[0]).toMatchObject({
        actorType: 'account',
        actorId: w.a.ids.guard,
        targetType: 'parcel',
        metadata: { carrier: 'jumia', pieces: 5, parcelNumber: row.number },
      });
      expect(JSON.stringify(rows[0])).not.toContain('PII-AUDIT');
      expect(JSON.stringify(rows[0])).not.toContain(row.photoFileId!);
    });
  });
});
