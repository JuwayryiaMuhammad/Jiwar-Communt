import { Client } from 'pg';
import { keyPaths, listKeys } from '../api/keys';
import { call, err } from '../api/request';
import { buildWorld, type World } from '../api/world';
import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { parcelScenes } from '../setup/parcels';
import { residentEntry } from '../setup/resident-entry';
import { required } from '../setup/test-env';

const MANAGER_PARCEL = [
  'carrier',
  'handedOverAt',
  'heldDays',
  'heldLongNotified',
  'id',
  'number',
  'pieces',
  'receivedAt',
  'rejectReason',
  'rejectedAt',
  'reminded',
  'returnReason',
  'returnedAt',
  'status',
  'unclaimable',
  'unitCode',
];

describe('Parcels — the managers (ADR 0035)', () => {
  let h: HttpHarness;
  let w: World;
  let db: Client;
  let s: ReturnType<typeof parcelScenes>;
  let inA: ReturnType<typeof residentEntry>['inA'];

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
    db = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await db.connect();
    s = parcelScenes(w);
    inA = residentEntry(() => ({ h, w, db })).inA;
  }, 120_000);

  afterAll(async () => {
    await db.end();
    await h.close();
  });

  const manager = (path: string, query: Record<string, string> = {}) =>
    call(w, 'GET', path, { token: w.a.tokens.manager, query });
  const patch = (body: object, token = w.a.tokens.manager) =>
    call(w, 'PATCH', '/parcel-settings', { token, body });

  describe('the parcels', () => {
    it('every parcel with its unit and status: no label, no delegate, no photo, no code', async () => {
      const home = await s.household();
      const parcel = await s.receive(home.unitCode, {
        carrier: 'talabat',
        pieces: 6,
        labelName: 'PII-MGR-label',
      });
      await call(w, 'POST', `/me/parcels/${parcel.id}/delegate`, {
        token: home.owner.token,
        body: { name: 'PII-MGR-delegate' },
      }).expect(201);
      const list = await manager('/parcels', { unitCode: home.unitCode });
      expect(list.status).toBe(200);
      expect(keyPaths(list.body)).toEqual(listKeys(MANAGER_PARCEL));
      expect((list.body as { data: unknown[] }).data).toEqual([
        {
          id: parcel.id,
          number: parcel.number,
          unitCode: home.unitCode,
          carrier: 'talabat',
          pieces: 6,
          status: 'held',
          receivedAt: expect.any(String) as string,
          handedOverAt: null,
          rejectedAt: null,
          rejectReason: null,
          returnedAt: null,
          returnReason: null,
          heldDays: 0,
          reminded: false,
          heldLongNotified: false,
          unclaimable: false,
        },
      ]);
      const detail = await manager(`/parcels/${parcel.id}`);
      expect(detail.status).toBe(200);
      expect(keyPaths(detail.body)).toEqual(
        [
          ...MANAGER_PARCEL,
          'events',
          'events[].actorSide',
          'events[].at',
          'events[].kind',
          'events[].method',
          'events[].reasonCode',
        ].sort(),
      );
      expect(
        (detail.body as { events: { kind: string }[] }).events,
      ).toMatchObject([
        { kind: 'received', actorSide: 'guard' },
        { kind: 'delegate_authorized', actorSide: 'resident' },
      ]);
      for (const text of [list.text, detail.text]) {
        expect(text).not.toContain('PII-MGR');
        expect(text).not.toMatch(/photo|labelName|delegate"|pickup|"code"/i);
        expect(text).not.toContain('JWP1.');
      }
    });

    it('filters by status, unit and carrier, pages newest first, and never shows another compound’s', async () => {
      const home = await s.solo();
      const made = [
        await s.receive(home.unitCode, { carrier: 'dhl' }),
        await s.receive(home.unitCode, { carrier: 'ups' }),
        await s.receive(home.unitCode, { carrier: 'dhl' }),
      ];
      await call(w, 'POST', `/me/parcels/${made[0].id}/reject`, {
        token: home.owner.token,
        body: { reasonCode: 'not_ours' },
      }).expect(200);
      const ids = (res: { body: unknown }) =>
        (res.body as { data: { id: string }[] }).data.map((p) => p.id);
      expect(
        ids(await manager('/parcels', { unitCode: home.unitCode })),
      ).toEqual([made[2].id, made[1].id, made[0].id]);
      expect(
        ids(
          await manager('/parcels', {
            unitCode: home.unitCode,
            status: 'rejected',
          }),
        ),
      ).toEqual([made[0].id]);
      expect(
        ids(
          await manager('/parcels', {
            unitCode: home.unitCode,
            carrier: 'dhl',
          }),
        ),
      ).toEqual([made[2].id, made[0].id]);
      const first = await manager('/parcels', {
        unitCode: home.unitCode,
        limit: '2',
      });
      const page = first.body as { data: { id: string }[]; nextCursor: string };
      expect(page.data.map((p) => p.id)).toEqual([made[2].id, made[1].id]);
      expect(
        ids(
          await manager('/parcels', {
            unitCode: home.unitCode,
            limit: '2',
            cursor: page.nextCursor,
          }),
        ),
      ).toEqual([made[0].id]);
      expect(
        (await manager('/parcels', { unitCode: 'NO-SUCH-UNIT' })).body,
      ).toEqual({ data: [], nextCursor: null });
      const all = await manager('/parcels', { limit: '100' });
      expect(all.text).not.toContain(w.bParcelId);
      expect((await manager(`/parcels/${w.bParcelId}`)).status).toBe(404);
    });

    it('shows how long it was held, who was told, and a unit nobody could collect for', async () => {
      const home = await s.solo();
      const parcel = await s.receive(home.unitCode);
      await inA(
        `UPDATE parcels SET received_at = now() - interval '5 days',
                reminded_at = now(), held_long_at = now() WHERE id = $1`,
        [parcel.id],
      );
      const detail = (await manager(`/parcels/${parcel.id}`)).body as {
        heldDays: number;
        reminded: boolean;
        heldLongNotified: boolean;
      };
      expect(detail).toMatchObject({
        heldDays: 5,
        reminded: true,
        heldLongNotified: true,
      });
      const vacant = await w.helpers.unit(w.a);
      const lonely = await s.receive(vacant.code);
      expect(
        (
          (await manager(`/parcels/${lonely.id}`)).body as {
            unclaimable: boolean;
          }
        ).unclaimable,
      ).toBe(true);
    });

    it('only managers: a guard, a resident and a family member are refused', async () => {
      for (const token of [
        w.a.tokens.guard,
        w.a.tokens.owner,
        w.a.tokens.family,
        w.a.tokens.technician,
      ])
        for (const path of ['/parcels', '/parcel-settings']) {
          const res = await call(w, 'GET', path, { token });
          expect({ status: res.status, code: err(res).code }).toEqual({
            status: 403,
            code: 'FORBIDDEN',
          });
        }
    });
  });

  describe('the holding periods', () => {
    afterEach(async () => {
      await patch({ parcelManagerDays: 14 });
      await patch({ parcelReminderDays: 3 });
    });

    it('3 and 14 days by default, in every compound', async () => {
      expect((await manager('/parcel-settings')).body).toEqual({
        parcelReminderDays: 3,
        parcelManagerDays: 14,
      });
      const b = await call(w, 'GET', '/parcel-settings', {
        token: w.b.tokens.manager,
      });
      expect(b.body).toEqual({ parcelReminderDays: 3, parcelManagerDays: 14 });
    });

    it('changes one or both, audited by diff; another compound keeps its own', async () => {
      const res = await patch({ parcelReminderDays: 2 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        parcelReminderDays: 2,
        parcelManagerDays: 14,
      });
      expect((await patch({ parcelManagerDays: 30 })).body).toEqual({
        parcelReminderDays: 2,
        parcelManagerDays: 30,
      });
      const rows = await auditReaders(h).tenant(w.a.tenantId, {
        action: 'parcel.settings_changed',
      });
      expect(rows[rows.length - 1].changes).toEqual({
        parcelManagerDays: { from: 14, to: 30 },
      });
      expect(
        (
          await call(w, 'GET', '/parcel-settings', {
            token: w.b.tokens.manager,
          })
        ).body,
      ).toEqual({ parcelReminderDays: 3, parcelManagerDays: 14 });
    });

    it('the ranges hold, and the reminder always comes before the managers’ notice', async () => {
      for (const [body, fields] of [
        [
          { parcelReminderDays: 31 },
          [
            {
              field: 'parcelReminderDays',
              code: 'INVALID_NUMBER',
              params: { min: 1, max: 30 },
            },
          ],
        ],
        [
          { parcelManagerDays: 91 },
          [
            {
              field: 'parcelManagerDays',
              code: 'INVALID_NUMBER',
              params: { min: 2, max: 90 },
            },
          ],
        ],
        // The reminder may not reach the managers' day (14 now) ...
        [
          { parcelReminderDays: 14 },
          [
            {
              field: 'parcelReminderDays',
              code: 'INVALID_NUMBER',
              params: { min: 1, max: 13 },
            },
          ],
        ],
        // ... nor the managers' day fall to the reminder's (3 now).
        [
          { parcelManagerDays: 3 },
          [
            {
              field: 'parcelReminderDays',
              code: 'INVALID_NUMBER',
              params: { min: 1, max: 2 },
            },
          ],
        ],
      ] as const) {
        const res = await patch(body);
        expect(res.status).toBe(400);
        expect(err(res).fields).toEqual(fields);
      }
      expect((await manager('/parcel-settings')).body).toEqual({
        parcelReminderDays: 3,
        parcelManagerDays: 14,
      });
    });

    it('only a manager may change them', async () => {
      for (const token of [w.a.tokens.guard, w.a.tokens.owner])
        expect((await patch({ parcelReminderDays: 2 }, token)).status).toBe(
          403,
        );
    });
  });
});
