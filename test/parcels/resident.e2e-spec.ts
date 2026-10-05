import { AccountsService } from '../../src/core/accounts/accounts.service';
import { newId } from '../../src/core/common/uuid';
import { HouseholdsService } from '../../src/community/households/households.service';
import { ParcelTokens } from '../../src/gate/parcels/parcel-tokens';
import { ShiftsService } from '../../src/gate/shifts/shifts.service';
import { keyPaths, listKeys } from '../api/keys';
import { call, err } from '../api/request';
import { buildWorld, type World } from '../api/world';
import { auditReaders } from '../setup/audit';
import { gateHelpers } from '../setup/gate';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { parcelScenes, type Household } from '../setup/parcels';

const RESIDENT_PARCEL = [
  'carrier',
  'delegate',
  'handedOverAt',
  'handedOverMethod',
  'handoverPhoto',
  'id',
  'labelName',
  'number',
  'photo',
  'photo.expiresAt',
  'photo.url',
  'pickup',
  'pickup.code',
  'pickup.qrPayload',
  'pieces',
  'receivedAt',
  'rejectReason',
  'rejectedAt',
  'returnedAt',
  'status',
  'unitCode',
];
const DELEGATE = [
  'delegate.authorizedAt',
  'delegate.code',
  'delegate.name',
  'delegate.qrPayload',
];

/** A replay is re-rendered, so its presigned URLs are signed again: compare the rest. */
function stable(body: unknown): unknown {
  const { photo, handoverPhoto, ...rest } = body as Record<string, unknown>;
  return {
    ...rest,
    photo: photo === null ? null : 'url',
    handoverPhoto: handoverPhoto === null ? null : 'url',
  };
}

describe('Parcels — the residents’ side (ADR 0035)', () => {
  let h: HttpHarness;
  let w: World;
  let s: ReturnType<typeof parcelScenes>;
  let tokens: ParcelTokens;

  const asManager = <T>(fn: () => Promise<T>) => w.helpers.asManager(w.a, fn);
  const parcelRow = (id: string) =>
    asManager(() =>
      w.helpers.prisma.tenant.parcel.findUniqueOrThrow({ where: { id } }),
    );
  const credentials = (parcelId: string) =>
    asManager(() =>
      w.helpers.prisma.tenant.parcelCredential.findMany({
        where: { parcelId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  const events = (parcelId: string) =>
    asManager(() =>
      w.helpers.prisma.tenant.parcelEvent.findMany({
        where: { parcelId },
        orderBy: [{ at: 'asc' }, { id: 'asc' }],
      }),
    );
  const notifications = (accountId: string, kind: string) =>
    asManager(() =>
      w.helpers.prisma.tenant.notification.findMany({
        where: { accountId, kind },
        orderBy: { createdAt: 'asc' },
      }),
    );
  /** The code a credential shows, derived the way the views derive it. */
  const codeOf = (c: { id: string; attempt: number }) =>
    tokens.secretOf(w.a.tenantId, c.id, c.attempt).code;

  const get = (token: string, id: string) =>
    call(w, 'GET', `/me/parcels/${id}`, { token });
  const reject = (token: string, id: string, reasonCode?: string) =>
    call(w, 'POST', `/me/parcels/${id}/reject`, {
      token,
      body: reasonCode ? { reasonCode } : {},
    });
  const delegate = (token: string, id: string, name = 'Karim') =>
    call(w, 'POST', `/me/parcels/${id}/delegate`, { token, body: { name } });
  const revoke = (token: string, id: string) =>
    call(w, 'POST', `/me/parcels/${id}/delegate/revoke`, { token });

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
    s = parcelScenes(w);
    tokens = h.moduleRef.get(ParcelTokens);
  }, 120_000);

  afterAll(() => h.close());

  describe('reading', () => {
    let home: Household;
    let parcel: { id: string; number: number };

    beforeAll(async () => {
      home = await s.household();
      parcel = await s.receive(home.unitCode, {
        carrier: 'amazon',
        pieces: 2,
        labelName: 'Layla Hassan',
      });
    });

    it('the primary and a member read it with the label, the photo and the code; no-store', async () => {
      for (const who of [home.owner, home.member]) {
        const res = await get(who.token, parcel.id);
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(keyPaths(res.body)).toEqual(RESIDENT_PARCEL);
        const body = res.body as {
          pickup: { code: string; qrPayload: string };
          photo: { url: string };
        };
        expect(res.body).toMatchObject({
          id: parcel.id,
          number: parcel.number,
          unitCode: home.unitCode,
          carrier: 'amazon',
          pieces: 2,
          status: 'held',
          labelName: 'Layla Hassan',
          delegate: null,
          handoverPhoto: null,
          handedOverMethod: null,
        });
        const [holder] = await credentials(parcel.id);
        expect(body.pickup.code).toBe(codeOf(holder));
        expect(body.pickup.code).toMatch(/^\d{6}$/);
        expect(body.pickup.qrPayload).toBe(
          tokens.secretOf(w.a.tenantId, holder.id, holder.attempt).qrPayload,
        );
        const row = await parcelRow(parcel.id);
        expect(body.photo.url).toContain(
          `t/${w.a.tenantId}/${row.photoFileId}`,
        );
      }
    });

    it('the code is the same on every read; the database cannot show it', async () => {
      const a = (await get(home.owner.token, parcel.id)).body as {
        pickup: { code: string };
      };
      const b = (await get(home.member.token, parcel.id)).body as {
        pickup: { code: string };
      };
      expect(a.pickup.code).toBe(b.pickup.code);
      const [holder] = await credentials(parcel.id);
      expect(JSON.stringify(holder)).not.toContain(a.pickup.code);
    });

    it('lists their parcels, newest first, and filters by status', async () => {
      const second = await s.receive(home.unitCode);
      const list = await call(w, 'GET', '/me/parcels', {
        token: home.owner.token,
      });
      expect(list.status).toBe(200);
      expect(list.headers['cache-control']).toBe('no-store');
      expect(keyPaths(list.body)).toEqual(
        listKeys(RESIDENT_PARCEL.filter((k) => !DELEGATE.includes(k))),
      );
      expect(
        (list.body as { data: { id: string }[] }).data.map((p) => p.id),
      ).toEqual([second.id, parcel.id]);
      const none = await call(w, 'GET', '/me/parcels', {
        token: home.owner.token,
        query: { status: 'handed_over' },
      });
      expect(none.body).toEqual({ data: [], nextCursor: null });
      const page = await call(w, 'GET', '/me/parcels', {
        token: home.owner.token,
        query: { limit: '1' },
      });
      const first = page.body as {
        data: { id: string }[];
        nextCursor: string | null;
      };
      expect(first.data.map((p) => p.id)).toEqual([second.id]);
      const next = await call(w, 'GET', '/me/parcels', {
        token: home.owner.token,
        query: { limit: '1', cursor: first.nextCursor! },
      });
      expect(
        (next.body as { data: { id: string }[] }).data.map((p) => p.id),
      ).toEqual([parcel.id]);
    });

    it('nobody who is not eligible for the unit reads it: not found, whoever they are', async () => {
      // A landlord who does not live there, a tenant of another unit, the
      // guard, the manager, and another compound's resident.
      const others = [
        w.a.tokens.landlord,
        w.a.tokens.tenant,
        w.a.tokens.guard,
        w.a.tokens.manager,
        w.b.tokens.owner,
      ];
      for (const token of others) {
        const res = await get(token, parcel.id);
        expect({ status: res.status, code: err(res).code }).toEqual({
          status: 404,
          code: 'PARCEL_NOT_FOUND',
        });
        const list = await call(w, 'GET', '/me/parcels', { token });
        expect(JSON.stringify(list.body)).not.toContain(parcel.id);
      }
      // An unknown id answers the same.
      const unknown = await get(home.owner.token, newId());
      expect(unknown.status).toBe(404);
      expect(err(unknown).code).toBe('PARCEL_NOT_FOUND');
    });

    it('a landlord of the unit and a tenant who lives there: only the one who lives there', async () => {
      const rentedCode = (
        await asManager(() =>
          w.helpers.prisma.tenant.unit.findUniqueOrThrow({
            where: { id: w.a.rentedUnitId },
          }),
        )
      ).code;
      const rented = await s.receive(rentedCode);
      expect((await get(w.a.tokens.tenant, rented.id)).status).toBe(200);
      expect((await get(w.a.tokens.landlord, rented.id)).status).toBe(404);
    });
  });

  describe('"not mine"', () => {
    it('rejects it: held → rejected for good, the codes die, the guards on shift are told', async () => {
      const home = await s.household();
      const p = await s.receive(home.unitCode, {
        carrier: 'noon',
        pieces: 3,
        labelName: 'Not Ours',
      });
      const [holder] = await credentials(p.id);
      const res = await reject(home.owner.token, p.id, 'not_ours');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({
        id: p.id,
        status: 'rejected',
        rejectReason: 'not_ours',
        pickup: null,
        labelName: 'Not Ours',
      });
      expect((res.body as { rejectedAt: string }).rejectedAt).toEqual(
        expect.any(String),
      );
      const row = await parcelRow(p.id);
      expect(row).toMatchObject({
        status: 'rejected',
        rejectReason: 'not_ours',
        closedAt: null,
      });
      // The credential is dead at commit: no hash left, nothing to find it by.
      const [ended] = await credentials(p.id);
      expect(ended).toMatchObject({
        id: holder.id,
        codeHash: null,
        qrTokenHash: null,
        endReason: 'rejected',
      });
      expect(ended.endedAt).not.toBeNull();
      expect(await events(p.id)).toMatchObject([
        { kind: 'received', actorSide: 'guard' },
        {
          kind: 'rejected',
          actorSide: 'resident',
          actorId: home.owner.id,
          reasonCode: 'not_ours',
          method: null,
        },
      ]);
      // The guard on shift at the gate is told: the number and the carrier.
      const told = (
        await notifications(w.a.ids.guard, 'parcel.rejected')
      ).filter((n) => n.targetId === p.id);
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({
        priority: 'normal',
        targetType: 'parcel',
        params: { parcelNumber: p.number, carrier: 'noon' },
      });
      expect(JSON.stringify(told[0].params)).not.toContain('Not Ours');
      // Nobody else: not the rejecter's household, not the manager.
      for (const who of [home.owner.id, home.member.id, w.a.ids.manager])
        expect(
          (await notifications(who, 'parcel.rejected')).filter(
            (n) => n.targetId === p.id,
          ),
        ).toEqual([]);
    });

    it('a guard who starts a shift at the gate later is told, once per parcel', async () => {
      const home = await s.household();
      const p = await s.receive(home.unitCode, { carrier: 'ups' });
      await reject(home.member.token, p.id, 'not_expected').then((r) =>
        expect(r.status).toBe(200),
      );
      const g = await gateHelpers(h).guard(w.a);
      expect(await notifications(g.id, 'parcel.rejected')).toEqual([]);
      await gateHelpers(h).startShift(w.a, g.id, w.a.gateId);
      const told = await notifications(g.id, 'parcel.rejected');
      expect(told.map((n) => n.targetId)).toContain(p.id);
      expect(told.find((n) => n.targetId === p.id)?.params).toEqual({
        parcelNumber: p.number,
        carrier: 'ups',
      });
      // A second shift does not tell them again.
      await w.helpers.as(w.a, { id: g.id, type: 'staff' }, () =>
        h.moduleRef.get(ShiftsService).end(),
      );
      await gateHelpers(h).startShift(w.a, g.id, w.a.gateId);
      expect(
        (await notifications(g.id, 'parcel.rejected')).filter(
          (n) => n.targetId === p.id,
        ),
      ).toHaveLength(1);
    });

    it('the reason is from a closed list; a second rejection or a handed-over parcel is a conflict', async () => {
      const home = await s.household();
      const p = await s.receive(home.unitCode);
      for (const [body, fields] of [
        [undefined, [{ field: 'reasonCode', code: 'FIELD_REQUIRED' }]],
        [
          'because',
          [
            {
              field: 'reasonCode',
              code: 'INVALID_REASON_CODE',
              params: { allowed: ['not_ours', 'not_expected', 'other'] },
            },
          ],
        ],
      ] as const) {
        const res = await reject(home.owner.token, p.id, body);
        expect(res.status).toBe(400);
        expect(err(res).fields).toEqual(fields);
      }
      expect((await reject(home.owner.token, p.id, 'other')).status).toBe(200);
      const again = await reject(home.member.token, p.id, 'other');
      expect({
        status: again.status,
        code: err(again).code,
        params: err(again).params,
      }).toEqual({
        status: 409,
        code: 'PARCEL_STATE_CONFLICT',
        params: { status: 'rejected' },
      });
    });

    it('only an eligible occupant may; another compound’s parcel is not found', async () => {
      const home = await s.household();
      const p = await s.receive(home.unitCode);
      for (const token of [
        w.a.tokens.landlord,
        w.a.tokens.tenant,
        w.a.tokens.guard,
        w.a.tokens.manager,
      ]) {
        const res = await reject(token, p.id, 'other');
        expect({ status: res.status, code: err(res).code }).toEqual({
          status: 404,
          code: 'PARCEL_NOT_FOUND',
        });
      }
      expect(
        (await reject(w.a.tokens.owner, w.bParcelId, 'other')).status,
      ).toBe(404);
      expect((await parcelRow(p.id)).status).toBe('held');
    });

    it('Idempotency-Key: a retry answers the same, rejects once, stores no body', async () => {
      const home = await s.household();
      const p = await s.receive(home.unitCode, { labelName: 'PII-IDEM-label' });
      const send = () =>
        call(w, 'POST', `/me/parcels/${p.id}/reject`, {
          token: home.owner.token,
          body: { reasonCode: 'other' },
        }).set('Idempotency-Key', `reject-${p.id}`);
      const first = await send();
      const again = await send();
      expect([first.status, again.status]).toEqual([200, 200]);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(stable(again.body)).toEqual(stable(first.body));
      expect(
        (await events(p.id)).filter((e) => e.kind === 'rejected'),
      ).toHaveLength(1);
      // The key row holds no response (it would hold the label).
      const stored = await asManager(() =>
        w.helpers.prisma.tenant.idempotencyKey.findMany({
          where: { key: `reject-${p.id}` },
        }),
      );
      expect(stored).toHaveLength(1);
      expect(JSON.stringify(stored)).not.toContain('PII-IDEM-label');
    });

    it('audit: parcel.rejected carries the reason code and nothing else', async () => {
      const home = await s.household();
      const p = await s.receive(home.unitCode, { labelName: 'PII-REJ-label' });
      await reject(home.owner.token, p.id, 'not_expected');
      const rows = await auditReaders(h).tenant(w.a.tenantId, {
        action: 'parcel.rejected',
        targetId: p.id,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorType: 'account',
        actorId: home.owner.id,
        targetType: 'parcel',
        metadata: { reasonCode: 'not_expected' },
      });
      expect(JSON.stringify(rows[0])).not.toContain('PII-REJ');
    });
  });

  describe('the delegate', () => {
    let home: Household;
    let p: { id: string; number: number };

    beforeEach(async () => {
      home = await s.household();
      p = await s.receive(home.unitCode, { labelName: 'Layla Hassan' });
    });

    it('authorizes one: a name, a code of its own, shown to the unit, never stored', async () => {
      const res = await delegate(home.owner.token, p.id, '  Karim Adel  ');
      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(keyPaths(res.body)).toEqual(
        [...RESIDENT_PARCEL, ...DELEGATE].sort(),
      );
      const body = res.body as {
        pickup: { code: string };
        delegate: { name: string; code: string; qrPayload: string };
      };
      expect(body.delegate.name).toBe('Karim Adel');
      expect(body.delegate.code).toMatch(/^\d{6}$/);
      expect(body.delegate.code).not.toBe(body.pickup.code);
      expect(body.delegate.qrPayload).toMatch(/^JWP1\.[A-Za-z0-9_-]{43}$/);

      const rows = await credentials(p.id);
      expect(rows.map((c) => c.kind)).toEqual(['holder', 'delegate']);
      const d = rows[1];
      expect(d).toMatchObject({
        delegateName: 'Karim Adel',
        createdById: home.owner.id,
        endedAt: null,
      });
      expect(codeOf(d)).toBe(body.delegate.code);
      expect(JSON.stringify(d)).not.toContain(body.delegate.code);
      // The other occupant sees the same delegate and the same code.
      const other = (await get(home.member.token, p.id)).body as typeof body;
      expect(other.delegate).toMatchObject({
        name: 'Karim Adel',
        code: body.delegate.code,
      });
      expect(await events(p.id)).toMatchObject([
        { kind: 'received' },
        {
          kind: 'delegate_authorized',
          actorSide: 'resident',
          actorId: home.owner.id,
        },
      ]);
    });

    it('one delegate per parcel: a second is a conflict, even at the same moment', async () => {
      const [a, b] = await Promise.all([
        delegate(home.owner.token, p.id, 'First'),
        delegate(home.member.token, p.id, 'Second'),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const loser = a.status === 409 ? a : b;
      expect(err(loser).code).toBe('PARCEL_DELEGATE_EXISTS');
      expect(
        (await credentials(p.id)).filter((c) => c.kind === 'delegate'),
      ).toHaveLength(1);
    });

    it('a name of 1 to 80 characters, no phone, no unknown field', async () => {
      for (const name of ['', '   ', 'x'.repeat(81)]) {
        const res = await delegate(home.owner.token, p.id, name);
        expect(res.status).toBe(400);
        expect(err(res).fields).toEqual([
          {
            field: 'name',
            code: 'INVALID_LENGTH',
            params: { min: 1, max: 80 },
          },
        ]);
      }
      const phone = await call(w, 'POST', `/me/parcels/${p.id}/delegate`, {
        token: home.owner.token,
        body: { name: 'Karim', phone: '+201001234567' },
      });
      expect(phone.status).toBe(400);
      expect(err(phone).fields).toEqual([
        { field: 'phone', code: 'FIELD_NOT_ALLOWED' },
      ]);
      expect(await credentials(p.id)).toHaveLength(1);
    });

    it('revoking: the code dies, the name goes, any occupant may, a retry is a no-op', async () => {
      const made = await delegate(home.owner.token, p.id);
      const code = (made.body as { delegate: { code: string } }).delegate.code;
      expect((await revoke(home.member.token, p.id)).status).toBe(204);
      const [, d] = await credentials(p.id);
      expect(d).toMatchObject({
        codeHash: null,
        qrTokenHash: null,
        delegateName: null,
        endReason: 'revoked',
      });
      expect(JSON.stringify(d)).not.toContain(code);
      expect(
        ((await get(home.owner.token, p.id)).body as { delegate: unknown })
          .delegate,
      ).toBeNull();
      expect((await revoke(home.owner.token, p.id)).status).toBe(204);
      expect(
        (await events(p.id)).filter((e) => e.kind === 'delegate_revoked'),
      ).toMatchObject([
        {
          actorSide: 'resident',
          actorId: home.member.id,
          reasonCode: 'revoked',
        },
      ]);
      // A new delegate may be authorized, with a code of its own.
      const again = await delegate(home.owner.token, p.id, 'Someone Else');
      expect(again.status).toBe(201);
      expect(
        (again.body as { delegate: { code: string } }).delegate.code,
      ).not.toBe(code);
    });

    it('only eligible occupants, only while held; another compound’s parcel is not found', async () => {
      for (const token of [
        w.a.tokens.landlord,
        w.a.tokens.tenant,
        w.a.tokens.guard,
      ]) {
        for (const res of [
          await delegate(token, p.id),
          await revoke(token, p.id),
        ])
          expect({ status: res.status, code: err(res).code }).toEqual({
            status: 404,
            code: 'PARCEL_NOT_FOUND',
          });
      }
      expect((await delegate(w.a.tokens.owner, w.bParcelId)).status).toBe(404);
      await reject(home.owner.token, p.id, 'other');
      for (const res of [
        await delegate(home.owner.token, p.id),
        await revoke(home.owner.token, p.id),
      ])
        expect({
          status: res.status,
          code: err(res).code,
          params: err(res).params,
        }).toEqual({
          status: 409,
          code: 'PARCEL_STATE_CONFLICT',
          params: { status: 'rejected' },
        });
    });

    it('rejecting a parcel ends its delegate too, and the name goes with it', async () => {
      await delegate(home.owner.token, p.id, 'Karim');
      await reject(home.member.token, p.id, 'not_ours');
      const rows = await credentials(p.id);
      expect(rows.map((c) => [c.kind, c.endReason, c.delegateName])).toEqual([
        ['holder', 'rejected', null],
        ['delegate', 'rejected', null],
      ]);
    });

    it('Idempotency-Key: a retry derives the same code again and stores no body', async () => {
      const send = () =>
        call(w, 'POST', `/me/parcels/${p.id}/delegate`, {
          token: home.owner.token,
          body: { name: 'Karim' },
        }).set('Idempotency-Key', `delegate-${p.id}`);
      const first = await send();
      const again = await send();
      expect([first.status, again.status]).toEqual([201, 201]);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(stable(again.body)).toEqual(stable(first.body));
      expect(
        (await credentials(p.id)).filter((c) => c.kind === 'delegate'),
      ).toHaveLength(1);
      const stored = await asManager(() =>
        w.helpers.prisma.tenant.idempotencyKey.findMany({
          where: { key: `delegate-${p.id}` },
        }),
      );
      expect(JSON.stringify(stored)).not.toContain(
        (first.body as { delegate: { code: string } }).delegate.code,
      );
    });

    it('audit: authorized and revoked carry ids and a reason code, never the name or the code', async () => {
      await delegate(home.owner.token, p.id, 'PII-DELEGATE-name');
      await revoke(home.owner.token, p.id);
      const read = auditReaders(h);
      const [authorized] = await read.tenant(w.a.tenantId, {
        action: 'parcel.delegate_authorized',
        targetId: p.id,
      });
      expect(authorized).toMatchObject({
        actorId: home.owner.id,
        targetType: 'parcel',
      });
      const [revoked] = await read.tenant(w.a.tenantId, {
        action: 'parcel.delegate_revoked',
        targetId: p.id,
      });
      expect(revoked).toMatchObject({
        actorId: home.owner.id,
        metadata: { reasonCode: 'revoked' },
      });
      expect(JSON.stringify([authorized, revoked])).not.toContain(
        'PII-DELEGATE',
      );
    });
  });

  describe('a delegate does not outlive its authorizer', () => {
    const delegateOf = async (parcelId: string) =>
      (await credentials(parcelId)).find((c) => c.kind === 'delegate')!;

    /** The authorizer's delegate on a parcel of a fresh household. */
    async function authorized(who: 'owner' | 'member') {
      const home = await s.household();
      const p = await s.receive(home.unitCode);
      expect((await delegate(home[who].token, p.id)).status).toBe(201);
      return { home, p };
    }

    const expectEnded = async (parcelId: string, authorizer: string) => {
      const d = await delegateOf(parcelId);
      expect(d).toMatchObject({
        codeHash: null,
        qrTokenHash: null,
        delegateName: null,
        endReason: 'authorizer_left',
      });
      const ended = (await events(parcelId)).filter(
        (e) => e.kind === 'delegate_revoked',
      );
      expect(ended).toMatchObject([
        { actorSide: 'system', actorId: null, reasonCode: 'authorizer_left' },
      ]);
      const [row] = await auditReaders(h).tenant(w.a.tenantId, {
        action: 'parcel.delegate_revoked',
        targetId: parcelId,
      });
      expect(row.metadata).toMatchObject({ reasonCode: 'authorizer_left' });
      void authorizer;
    };

    it('their account is deactivated', async () => {
      const { home, p } = await authorized('member');
      await asManager(() =>
        h.moduleRef
          .get(AccountsService)
          .updateStatus(home.member.id, { status: 'inactive' }),
      );
      await expectEnded(p.id, home.member.id);
    });

    it('their account is frozen', async () => {
      const { home, p } = await authorized('member');
      await asManager(() =>
        h.moduleRef.get(AccountsService).freeze(home.member.id, {
          code: 'phone_reassigned',
          text: 'Not me',
        }),
      );
      await expectEnded(p.id, home.member.id);
    });

    it('they are removed from the household, and the primary’s own delegate stays', async () => {
      const home = await s.household();
      const p = await s.receive(home.unitCode);
      const q = await s.receive(home.unitCode);
      expect((await delegate(home.member.token, p.id, 'Ali')).status).toBe(201);
      expect((await delegate(home.owner.token, q.id, 'Omar')).status).toBe(201);
      await w.helpers.as(w.a, { id: home.owner.id, type: 'resident' }, () =>
        h.moduleRef.get(HouseholdsService).removeMember(home.member.memberId, {
          code: 'relation_ended',
          text: 'No longer',
        }),
      );
      await expectEnded(p.id, home.member.id);
      // The primary still lives there: their delegate is untouched.
      expect(await delegateOf(q.id)).toMatchObject({
        delegateName: 'Omar',
        endedAt: null,
      });
      expect(
        (await events(q.id)).filter((e) => e.kind === 'delegate_revoked'),
      ).toEqual([]);
    });

    it('they stop living there: a tenant who moves out, their delegate with them', async () => {
      const unit = await w.helpers.unit(w.a);
      const tenant = await w.helpers.resident(w.a, [unit.id], 'tenant');
      const token = await w.tokenFor(w.a, tenant.id, 'resident');
      const p = await s.receive(unit.code);
      expect((await delegate(token, p.id)).status).toBe(201);
      const [occupancy] = await w.helpers.occupancies(w.a, unit.id);
      await asManager(() =>
        w.helpers.residents.endOccupancy(occupancy.id, {
          code: 'moved_out',
          text: 'Left',
        }),
      );
      await expectEnded(p.id, tenant.id);
      // The parcel itself stays held: the next occupant may collect it, and
      // the one who left no longer reads it.
      expect((await parcelRow(p.id)).status).toBe('held');
      expect((await get(token, p.id)).status).toBe(404);
    });

    it('a parcel already rejected keeps its record: nothing more to end', async () => {
      const { home, p } = await authorized('member');
      await reject(home.owner.token, p.id, 'other');
      await asManager(() =>
        h.moduleRef
          .get(AccountsService)
          .updateStatus(home.member.id, { status: 'inactive' }),
      );
      expect(
        (await events(p.id)).filter((e) => e.kind === 'delegate_revoked'),
      ).toEqual([]);
      expect((await delegateOf(p.id)).endReason).toBe('rejected');
    });
  });
});
