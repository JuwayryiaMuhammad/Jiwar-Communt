import { Client } from 'pg';
import type { Response } from 'supertest';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import { newId } from '../../src/core/common/uuid';
import { ParcelTokens } from '../../src/gate/parcels/parcel-tokens';
import { VisitorPassesService } from '../../src/gate/visitors/visitor-passes.service';
import { keyPaths } from '../api/keys';
import { call, err } from '../api/request';
import { buildWorld, type World } from '../api/world';
import { auditReaders } from '../setup/audit';
import { gateHelpers } from '../setup/gate';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { parcelScenes, type SoloHousehold } from '../setup/parcels';
import { residentEntry, type Credential } from '../setup/resident-entry';
import { required } from '../setup/test-env';

const HANDED_OVER = [
  'carrier',
  'delegateName',
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

type Way = { code: string } | { qr: string } | { residentQr: string };

describe('Parcels — hand-over and return (ADR 0035)', () => {
  let h: HttpHarness;
  let w: World;
  let db: Client;
  let s: ReturnType<typeof parcelScenes>;
  let tokens: ParcelTokens;
  let entry: ReturnType<typeof residentEntry>;
  /** A guard of A on duty with a fresh rate-limit and lockout budget. */
  let guard: string;
  let guardId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
    db = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await db.connect();
    s = parcelScenes(w);
    tokens = h.moduleRef.get(ParcelTokens);
    entry = residentEntry(() => ({ h, w, db }));
  }, 120_000);

  afterAll(async () => {
    await db.end();
    await h.close();
  });

  beforeEach(async () => {
    const g = await s.guardOnDuty(w.a);
    guard = g.token;
    guardId = g.guardId;
  });

  const asManager = <T>(fn: () => Promise<T>) => w.helpers.asManager(w.a, fn);
  const row = (id: string) =>
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
  const holderCode = async (parcelId: string) => {
    const c = (await credentials(parcelId)).find((x) => x.kind === 'holder')!;
    return tokens.secretOf(w.a.tenantId, c.id, c.attempt);
  };
  const delegateSecret = async (parcelId: string) => {
    const c = (await credentials(parcelId)).find(
      (x) => x.kind === 'delegate' && x.endedAt === null,
    )!;
    return tokens.secretOf(w.a.tenantId, c.id, c.attempt);
  };

  const handover = (
    id: string,
    body: object,
    token = guard,
    key?: string,
  ): Promise<Response> => {
    const req = call(w, 'POST', `/gate/parcels/${id}/handover`, {
      token,
      body,
    });
    return Promise.resolve(key ? req.set('Idempotency-Key', key) : req);
  };
  // Promise.resolve sends the request now: a supertest request goes out only
  // when it is awaited, and the races depend on the order they are sent in.
  const lookup = (body: object, token = guard) =>
    Promise.resolve(call(w, 'POST', '/gate/parcels/lookup', { token, body }));
  const returned = (id: string, token = guard) =>
    Promise.resolve(call(w, 'POST', `/gate/parcels/${id}/return`, { token }));
  const reject = (token: string, id: string, reasonCode = 'other') =>
    Promise.resolve(
      call(w, 'POST', `/me/parcels/${id}/reject`, {
        token,
        body: { reasonCode },
      }),
    );
  const authorize = (token: string, id: string, name = 'Karim') =>
    Promise.resolve(
      call(w, 'POST', `/me/parcels/${id}/delegate`, { token, body: { name } }),
    );
  const revoke = (token: string, id: string) =>
    Promise.resolve(
      call(w, 'POST', `/me/parcels/${id}/delegate/revoke`, { token }),
    );
  const outcome = (res: Response) => ({
    status: res.status,
    code: err(res).code,
  });

  /** A household (the primary alone) with a parcel. */
  async function scene(over: Record<string, unknown> = {}) {
    const home = await s.solo();
    const parcel = await s.receive(home.unitCode, over);
    return { home, parcel, id: parcel.id };
  }

  /** The same with a family member too (a second eligible occupant). */
  async function sceneWith(over: Record<string, unknown> = {}) {
    const home = await s.household();
    const parcel = await s.receive(home.unitCode, over);
    return { home, parcel, id: parcel.id };
  }

  /** Raw SQL in A as the table owner (FORCE RLS binds it too). */
  const inA: ReturnType<typeof residentEntry>['inA'] = (...args) =>
    entry.inA(...args);

  /**
   * Holds the parcel's row lock from another connection while `fire` starts
   * its requests, one after the other; the lock is released when they have
   * all queued. Requests queue on a row lock in arrival order, so the order
   * of `fire` is the order they run in.
   */
  async function holdingLock<T>(
    parcelId: string,
    fire: () => Promise<T>,
  ): Promise<T> {
    const holder = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        w.a.tenantId,
      ]);
      await holder.query(`SELECT id FROM parcels WHERE id = $1 FOR UPDATE`, [
        parcelId,
      ]);
      const pending = fire();
      // Let every request reach the lock before it is released.
      await new Promise((r) => setTimeout(r, 1500));
      await holder.query('COMMIT');
      return await pending;
    } finally {
      await holder.end();
    }
  }
  const pause = (ms = 400) => new Promise((r) => setTimeout(r, ms));

  // --------------------------------------------------------------------------
  describe('by the parcel’s code or QR', () => {
    it('hands it over: all pieces at once, the credentials die, the history and the audit say how', async () => {
      const { home, parcel, id } = await scene({
        carrier: 'dhl',
        pieces: 3,
        labelName: 'PII-HAND-label',
      });
      const secret = await holderCode(id);
      const res = await handover(id, { code: secret.code });
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(keyPaths(res.body)).toEqual(HANDED_OVER);
      expect(res.body).toMatchObject({
        id,
        number: parcel.number,
        pieces: 3,
        status: 'handed_over',
        delegateName: null,
      });
      expect(JSON.stringify(res.body)).not.toContain('PII-HAND');

      const done = await row(id);
      expect(done).toMatchObject({
        status: 'handed_over',
        handedOverMethod: 'code',
        handedToId: null,
        rejectedAt: null,
      });
      expect(done.handedOverAt).not.toBeNull();
      expect(done.closedAt).toEqual(done.handedOverAt);
      // Dead at commit: no hash left to find it by.
      expect(await credentials(id)).toMatchObject([
        { codeHash: null, qrTokenHash: null, endReason: 'handed_over' },
      ]);
      expect(await events(id)).toMatchObject([
        { kind: 'received' },
        {
          kind: 'handed_over',
          actorSide: 'guard',
          actorId: guardId,
          method: 'code',
          reasonCode: null,
        },
      ]);
      const [audit] = await auditReaders(h).tenant(w.a.tenantId, {
        action: 'parcel.handed_over',
        targetId: id,
      });
      expect(audit).toMatchObject({
        actorId: guardId,
        targetType: 'parcel',
        metadata: { method: 'code' },
      });
      expect(JSON.stringify(audit)).not.toContain('PII-HAND');
      // The code is spent.
      const again = await handover(id, { code: secret.code });
      expect(outcome(again)).toEqual({
        status: 409,
        code: 'PARCEL_STATE_CONFLICT',
      });
      expect(err(again).params).toEqual({ status: 'handed_over' });
      // The residents' view no longer shows a code.
      const view = await call(w, 'GET', `/me/parcels/${id}`, {
        token: home.owner.token,
      });
      expect(view.body).toMatchObject({
        status: 'handed_over',
        pickup: null,
        handedOverMethod: 'code',
      });
    });

    it('the QR works as the code does, and the lookup says what it is first', async () => {
      const { id } = await scene();
      const secret = await holderCode(id);
      const looked = await lookup({ qr: secret.qrPayload });
      expect(looked.status).toBe(200);
      expect(looked.headers['cache-control']).toBe('no-store');
      expect(keyPaths(looked.body)).toEqual(
        [
          'delegateName',
          'parcel',
          ...HANDED_OVER.filter((k) => k !== 'delegateName').map(
            (k) => `parcel.${k}`,
          ),
          'presentedBy',
          'result',
        ].sort(),
      );
      expect(looked.body).toMatchObject({
        result: 'valid',
        presentedBy: 'holder',
        delegateName: null,
        parcel: { id, status: 'held' },
      });
      // Read-only: still held, and the typed code is the same parcel.
      expect((await row(id)).status).toBe('held');
      expect((await lookup({ code: ` ${secret.code} ` })).body).toMatchObject({
        result: 'valid',
        parcel: { id },
      });
      expect((await handover(id, { qr: secret.qrPayload })).body).toMatchObject(
        { status: 'handed_over' },
      );
    });

    it('the unit’s other residents are told how it went, never to whom', async () => {
      const { home, parcel, id } = await sceneWith({
        carrier: 'noon',
        pieces: 2,
      });
      await handover(id, { code: (await holderCode(id)).code });
      for (const who of [home.owner.id, home.member.id]) {
        const told = (await notifications(who, 'parcel.collected')).filter(
          (n) => n.targetId === id,
        );
        expect(told).toHaveLength(1);
        expect(told[0]).toMatchObject({
          priority: 'normal',
          targetType: 'parcel',
          params: {
            carrier: 'noon',
            pieces: 2,
            unitCode: home.unitCode,
            method: 'code',
          },
        });
      }
      void parcel;
      // Nobody else is: not the guard, not the manager, not another unit.
      for (const who of [guardId, w.a.ids.manager, w.a.ids.tenant])
        expect(
          (await notifications(who, 'parcel.collected')).filter(
            (n) => n.targetId === id,
          ),
        ).toEqual([]);
    });

    it('an optional photo of the hand-over moves to the parcel; a bad one leaves it held', async () => {
      const { home, id } = await scene();
      const secret = await holderCode(id);
      const bad = await handover(id, {
        code: secret.code,
        photoFileId: newId(),
      });
      expect({
        status: bad.status,
        fields: err(bad).fields,
      }).toEqual({
        status: 400,
        fields: [{ field: 'photoFileId', code: 'FILE_NOT_AVAILABLE' }],
      });
      expect((await row(id)).status).toBe('held');
      expect((await credentials(id))[0].codeHash).not.toBeNull();

      const photoFileId = await s.photo(guard);
      const ok = await handover(id, { code: secret.code, photoFileId });
      expect(ok.status).toBe(200);
      const done = await row(id);
      expect(done.handoverPhotoFileId).toBe(photoFileId);
      const detail = await call(w, 'GET', `/gate/parcels/${id}`, {
        token: guard,
      });
      expect(
        (detail.body as { handoverPhoto: { url: string } }).handoverPhoto.url,
      ).toContain(`t/${w.a.tenantId}/${photoFileId}`);
      const mine = await call(w, 'GET', `/me/parcels/${id}`, {
        token: home.owner.token,
      });
      expect(
        (mine.body as { handoverPhoto: { url: string } }).handoverPhoto.url,
      ).toContain(photoFileId);
      // Used once.
      const second = await scene();
      const reuse = await handover(second.id, {
        code: (await holderCode(second.id)).code,
        photoFileId,
      });
      expect(reuse.status).toBe(400);
    });

    it('Idempotency-Key: a retry answers the same and records once', async () => {
      const { id } = await scene();
      const body = { code: (await holderCode(id)).code };
      const first = await handover(id, body, guard, `handover-${id}`);
      const again = await handover(id, body, guard, `handover-${id}`);
      expect([first.status, again.status]).toEqual([200, 200]);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body).toEqual(first.body);
      expect(
        (await events(id)).filter((e) => e.kind === 'handed_over'),
      ).toHaveLength(1);
      const stored = await asManager(() =>
        w.helpers.prisma.tenant.idempotencyKey.findMany({
          where: { key: `handover-${id}` },
        }),
      );
      expect(stored).toHaveLength(1);
      expect(stored[0].responseBody).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  describe('the state machine', () => {
    type Status = 'held' | 'handed_over' | 'rejected' | 'returned';
    type Action = 'handover' | 'reject' | 'return' | 'authorize' | 'revoke';

    /** A parcel in `status`, and the household that owns it. */
    async function inStatus(status: Status) {
      const { home, id } = await scene();
      const secret = await holderCode(id);
      if (status === 'handed_over')
        expect((await handover(id, { code: secret.code })).status).toBe(200);
      if (status === 'rejected' || status === 'returned')
        expect((await reject(home.owner.token, id)).status).toBe(200);
      if (status === 'returned') expect((await returned(id)).status).toBe(200);
      return { home, id, secret };
    }

    const act = (
      action: Action,
      p: { home: SoloHousehold; id: string; secret: { code: string } },
    ) => {
      switch (action) {
        case 'handover':
          return handover(p.id, { code: p.secret.code });
        case 'reject':
          return reject(p.home.owner.token, p.id);
        case 'return':
          return returned(p.id);
        case 'authorize':
          return authorize(p.home.owner.token, p.id);
        case 'revoke':
          return revoke(p.home.owner.token, p.id);
      }
    };

    /** Every transition: the status it reaches, or the refusal. */
    const TABLE: [Status, Action, Status | { status: number; code: string }][] =
      [
        ['held', 'handover', 'handed_over'],
        ['held', 'reject', 'rejected'],
        ['held', 'return', { status: 409, code: 'PARCEL_NOT_YET_RETURNABLE' }],
        ['held', 'authorize', 'held'],
        ['held', 'revoke', 'held'],
        [
          'handed_over',
          'handover',
          { status: 409, code: 'PARCEL_STATE_CONFLICT' },
        ],
        [
          'handed_over',
          'reject',
          { status: 409, code: 'PARCEL_STATE_CONFLICT' },
        ],
        [
          'handed_over',
          'return',
          { status: 409, code: 'PARCEL_STATE_CONFLICT' },
        ],
        [
          'handed_over',
          'authorize',
          { status: 409, code: 'PARCEL_STATE_CONFLICT' },
        ],
        [
          'handed_over',
          'revoke',
          { status: 409, code: 'PARCEL_STATE_CONFLICT' },
        ],
        [
          'rejected',
          'handover',
          { status: 409, code: 'PARCEL_STATE_CONFLICT' },
        ],
        ['rejected', 'reject', { status: 409, code: 'PARCEL_STATE_CONFLICT' }],
        ['rejected', 'return', 'returned'],
        [
          'rejected',
          'authorize',
          { status: 409, code: 'PARCEL_STATE_CONFLICT' },
        ],
        ['rejected', 'revoke', { status: 409, code: 'PARCEL_STATE_CONFLICT' }],
        [
          'returned',
          'handover',
          { status: 409, code: 'PARCEL_STATE_CONFLICT' },
        ],
        ['returned', 'reject', { status: 409, code: 'PARCEL_STATE_CONFLICT' }],
        ['returned', 'return', { status: 409, code: 'PARCEL_STATE_CONFLICT' }],
        [
          'returned',
          'authorize',
          { status: 409, code: 'PARCEL_STATE_CONFLICT' },
        ],
        ['returned', 'revoke', { status: 409, code: 'PARCEL_STATE_CONFLICT' }],
      ];

    it.each(TABLE)('%s + %s', async (status, action, expected) => {
      const p = await inStatus(status);
      const res = await act(action, p);
      if (typeof expected === 'string') {
        expect(res.status).toBeLessThan(300);
        expect((await row(p.id)).status).toBe(expected);
      } else {
        expect(outcome(res)).toEqual(expected);
        // A refusal changes nothing.
        expect((await row(p.id)).status).toBe(status);
        if (expected.code === 'PARCEL_STATE_CONFLICT')
          expect(err(res).params).toEqual({ status });
      }
    });

    it('the table is every status times every action', () => {
      expect(TABLE).toHaveLength(4 * 5);
    });

    it('a returned or handed-over parcel keeps no hash and no live credential', async () => {
      for (const status of ['handed_over', 'returned'] as const) {
        const { id } = await inStatus(status);
        for (const c of await credentials(id)) {
          expect(c).toMatchObject({ codeHash: null, qrTokenHash: null });
          expect(c.endedAt).not.toBeNull();
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  describe('races: the parcel’s lock gives each pair one winner', () => {
    it('two guards, the same code, at once: one hands it over, the other conflicts', async () => {
      const other = await s.guardOnDuty(w.a);
      const { home, id } = await scene();
      const code = (await holderCode(id)).code;
      const results = await Promise.all([
        handover(id, { code }, guard),
        handover(id, { code }, other.token),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect(err(loser).code).toBe('PARCEL_STATE_CONFLICT');
      expect(
        (await events(id)).filter((e) => e.kind === 'handed_over'),
      ).toHaveLength(1);
      const collected = await notifications(home.owner.id, 'parcel.collected');
      expect(collected.filter((n) => n.targetId === id)).toHaveLength(1);
    });

    it('a hand-over and a rejection: whichever commits first wins, in both orders', async () => {
      for (const first of ['handover', 'reject'] as const) {
        const { home, id } = await scene();
        const code = (await holderCode(id)).code;
        const fire = async () => {
          const run = {
            handover: () => handover(id, { code }),
            reject: () => reject(home.owner.token, id),
          };
          const a = run[first]();
          await pause();
          const b = run[first === 'handover' ? 'reject' : 'handover']();
          return Promise.all([a, b]);
        };
        const [winner, loser] = await holdingLock(id, fire);
        expect(winner.status).toBe(200);
        expect(outcome(loser)).toEqual({
          status: 409,
          code: 'PARCEL_STATE_CONFLICT',
        });
        expect((await row(id)).status).toBe(
          first === 'handover' ? 'handed_over' : 'rejected',
        );
        expect(err(loser).params).toEqual({
          status: first === 'handover' ? 'handed_over' : 'rejected',
        });
      }
    });

    it('a delegate revoked and a hand-over by that delegate’s code: in both orders', async () => {
      for (const first of ['revoke', 'handover'] as const) {
        const { home, id } = await sceneWith();
        await authorize(home.owner.token, id).then((r) =>
          expect(r.status).toBe(201),
        );
        const code = (await delegateSecret(id)).code;
        const run = {
          revoke: () => revoke(home.member.token, id),
          handover: () => handover(id, { code }),
        };
        const [a, b] = await holdingLock(id, async () => {
          const one = run[first]();
          await pause();
          const two = run[first === 'revoke' ? 'handover' : 'revoke']();
          return Promise.all([one, two]);
        });
        if (first === 'revoke') {
          // The revoke committed first: the code is dead, as if unknown.
          expect(a.status).toBe(204);
          expect(outcome(b)).toEqual({
            status: 403,
            code: 'PARCEL_CODE_INVALID',
          });
          expect((await row(id)).status).toBe('held');
        } else {
          // The hand-over committed first: nothing left to revoke.
          expect(a.status).toBe(200);
          expect((a.body as { delegateName: string }).delegateName).toBe(
            'Karim',
          );
          expect(outcome(b)).toEqual({
            status: 409,
            code: 'PARCEL_STATE_CONFLICT',
          });
          expect((await row(id)).status).toBe('handed_over');
        }
      }
    });

    it('the authorizer leaving and a hand-over by that delegate’s code: in both orders', async () => {
      for (const first of ['leave', 'handover'] as const) {
        const { home, id } = await sceneWith();
        await authorize(home.member.token, id).then((r) =>
          expect(r.status).toBe(201),
        );
        const code = (await delegateSecret(id)).code;
        const leave = () =>
          asManager(() =>
            h.moduleRef
              .get(AccountsService)
              .updateStatus(home.member.id, { status: 'inactive' }),
          );
        const run = { leave, handover: () => handover(id, { code }) };
        const results = await holdingLock(id, async () => {
          const one = run[first]().then(
            (r) => r,
            (e: unknown) => e,
          );
          await pause();
          const two = run[first === 'leave' ? 'handover' : 'leave']().then(
            (r) => r,
            (e: unknown) => e,
          );
          return Promise.all([one, two]);
        });
        const handoverResult = (
          first === 'handover' ? results[0] : results[1]
        ) as Response;
        const credential = (await credentials(id)).find(
          (c) => c.kind === 'delegate',
        )!;
        if (first === 'leave') {
          // The delegate ended first: the code is dead.
          expect(outcome(handoverResult)).toEqual({
            status: 403,
            code: 'PARCEL_CODE_INVALID',
          });
          expect(credential.endReason).toBe('authorizer_left');
          expect(credential.delegateName).toBeNull();
          expect((await row(id)).status).toBe('held');
        } else {
          // The hand-over came first: the delegate collected it, and the
          // authorizer's leaving finds a parcel that is no longer held.
          expect(handoverResult.status).toBe(200);
          expect(credential.endReason).toBe('handed_over');
          expect(
            (await events(id)).filter((e) => e.kind === 'delegate_revoked'),
          ).toEqual([]);
          expect((await row(id)).status).toBe('handed_over');
        }
      }
    });

    it('a rejection and a delegate being authorized: one winner, no live delegate on a rejected parcel', async () => {
      const { home, id } = await sceneWith();
      const [a, b] = await holdingLock(id, async () => {
        const one = reject(home.owner.token, id);
        await pause();
        const two = authorize(home.member.token, id);
        return Promise.all([one, two]);
      });
      expect(a.status).toBe(200);
      expect(outcome(b)).toEqual({
        status: 409,
        code: 'PARCEL_STATE_CONFLICT',
      });
      expect((await credentials(id)).filter((c) => c.endedAt === null)).toEqual(
        [],
      );
    });
  });

  // --------------------------------------------------------------------------
  describe('codes: only HMACs, enumeration-safe, throttled', () => {
    it('another compound’s code, another parcel’s, a dead one and a pass code: one answer, whatever was wrong', async () => {
      const { id } = await scene();
      const mine = await holderCode(id);
      const second = await scene();
      const theirs = await holderCode(second.id);
      // B's parcel code, derived for B.
      const bHolder = await inB(
        `SELECT id, attempt FROM parcel_credentials WHERE parcel_id = $1`,
        [w.bParcelId],
      );
      const bRow = bHolder.rows[0] as { id: string; attempt: number };
      const bCode = tokens.secretOf(w.b.tenantId, bRow.id, bRow.attempt);
      // A dead code: a parcel that was handed over.
      const spent = await scene();
      const spentCode = await holderCode(spent.id);
      await handover(spent.id, { code: spentCode.code });
      // A visitor pass code of the same compound.
      const pass = await w.helpers.as(
        w.a,
        { id: w.a.ids.owner, type: 'resident' },
        () =>
          h.moduleRef.get(VisitorPassesService).create(w.a.homeUnitId, {
            kind: 'one_time',
            partySize: 1,
            validFrom: new Date(),
            validUntil: new Date(Date.now() + 3_600_000),
          }),
      );
      const wrong: Way[] = [
        { code: '000000' },
        { code: 'abcdef' },
        { code: '12345' },
        { code: theirs.code },
        { code: bCode.code },
        { code: spentCode.code },
        { code: pass.code as string },
        { qr: theirs.qrPayload },
        { qr: bCode.qrPayload },
        { qr: spentCode.qrPayload },
        { qr: `JWR1.${'A'.repeat(43)}` },
        { qr: 'not a qr' },
      ];
      // Two ways per guard: five wrong answers would lock one out.
      const shapes = new Set<string>();
      const lookups = new Set<string>();
      let i = 0;
      let g = guard;
      for (const way of wrong) {
        if (i++ % 2 === 0) g = (await s.guardOnDuty(w.a)).token;
        // The spent parcel answers 409 (its status is plain to the guard); the
        // others are all the one answer.
        const res = await handover(id, way, g);
        shapes.add(
          JSON.stringify({
            status: res.status,
            code: err(res).code,
            body: omit(res),
          }),
        );
        // Another live parcel's code is a valid lookup (of that parcel); the
        // lookup of every other wrong code is the one answer.
        const [presented] = Object.values(way);
        if (presented !== theirs.code && presented !== theirs.qrPayload)
          lookups.add((await lookup(way, g)).text);
      }
      expect([...shapes]).toHaveLength(1);
      expect(JSON.parse([...shapes][0])).toMatchObject({
        status: 403,
        code: 'PARCEL_CODE_INVALID',
      });
      expect([...lookups]).toHaveLength(1);
      expect(JSON.parse([...lookups][0])).toEqual({
        result: 'invalid',
        parcel: null,
        presentedBy: null,
        delegateName: null,
      });
      // Nothing changed, and the right code still opens it.
      expect((await row(id)).status).toBe('held');
      expect((await handover(id, { code: mine.code })).status).toBe(200);
    });

    it('five wrong presentations lock the guard out until the window ends; another guard is untouched', async () => {
      const { id } = await scene();
      const code = (await holderCode(id)).code;
      const other = await s.guardOnDuty(w.a);
      for (let n = 0; n < 5; n++)
        expect(outcome(await handover(id, { code: '000000' }))).toEqual({
          status: 403,
          code: 'PARCEL_CODE_INVALID',
        });
      // Even the right code, a lookup and a resident QR: locked.
      for (const res of [
        await handover(id, { code }),
        await lookup({ code }),
        await handover(id, { residentQr: 'JWR2.x' }),
      ])
        expect(outcome(res)).toEqual({ status: 429, code: 'RATE_LIMITED' });
      expect((await row(id)).status).toBe('held');
      // Another guard on the same parcel is not.
      expect((await lookup({ code }, other.token)).status).toBe(200);
      expect((await handover(id, { code }, other.token)).status).toBe(200);
    });

    it('a guard off duty is told nothing: NO_OPEN_SHIFT before any code is looked at', async () => {
      const { id } = await scene();
      const g = await gateHelpers(h).guard(w.a);
      const token = await w.tokenFor(w.a, g.id, 'staff');
      for (const res of [
        await lookup({ code: '000000' }, token),
        await handover(id, { code: '000000' }, token),
        await returned(id, token),
      ])
        expect(outcome(res)).toEqual({ status: 403, code: 'NO_OPEN_SHIFT' });
    });

    it('thirty checks a minute per guard, wrong or right, then 429', async () => {
      const { id } = await scene();
      const code = (await holderCode(id)).code;
      const statuses: number[] = [];
      for (let n = 0; n < 31; n++)
        statuses.push((await lookup({ code })).status);
      expect(statuses.slice(0, 30)).toEqual(Array(30).fill(200));
      expect(statuses[30]).toBe(429);
    });

    it('exactly one of code, qr or residentQr', async () => {
      const { id } = await scene();
      const none = await handover(id, {});
      expect(none.status).toBe(400);
      expect(err(none).fields).toEqual([
        { field: 'code', code: 'FIELD_REQUIRED' },
      ]);
      const two = await handover(id, { code: '123456', qr: 'x' });
      expect(err(two).fields).toEqual([
        { field: 'qr', code: 'FIELD_NOT_ALLOWED' },
      ]);
      const lookupNone = await lookup({});
      expect(err(lookupNone).fields).toEqual([
        { field: 'code', code: 'FIELD_REQUIRED' },
      ]);
    });
  });

  // --------------------------------------------------------------------------
  describe('by a resident’s entry QR', () => {
    it('an eligible occupant of the unit receives it: recorded on the parcel, nothing else written', async () => {
      const { home, id } = await sceneWith({ carrier: 'ups', pieces: 1 });
      const phone: Credential = await entry.issue(home.owner.token);
      const before = {
        entries: await entry.count('gate_entries'),
        credentials: await entry.count('entry_credentials'),
        audit: await entry.count('audit_log'),
      };
      await entry.inSafeWindow();
      const res = await handover(id, {
        residentQr: entry.qr(phone),
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id, status: 'handed_over' });
      const done = await row(id);
      expect(done).toMatchObject({
        handedOverMethod: 'resident_qr',
        handedToId: home.owner.id,
      });
      expect(await events(id)).toMatchObject([
        { kind: 'received' },
        { kind: 'handed_over', actorSide: 'guard', method: 'resident_qr' },
      ]);

      // ADR 0031 stands: no gate entry or movement record was written, no
      // credential changed, and the only new audit row is the hand-over.
      expect(await entry.count('gate_entries')).toBe(before.entries);
      expect(await entry.count('entry_credentials')).toBe(before.credentials);
      expect(await entry.count('audit_log')).toBe(before.audit + 1);
      const credential = (
        await inA(`SELECT * FROM entry_credentials WHERE id = $1`, [phone.id])
      ).rows[0] as Record<string, unknown>;
      expect(Object.keys(credential).sort()).toEqual([
        'account_id',
        'created_at',
        'device_name',
        'id',
        'revoke_reason',
        'revoked_at',
        'tenant_id',
      ]);
      // The audit row names no one.
      const [audit] = await auditReaders(h).tenant(w.a.tenantId, {
        action: 'parcel.handed_over',
        targetId: id,
      });
      expect(audit.metadata).toEqual({ method: 'resident_qr' });
      expect(JSON.stringify(audit)).not.toContain(home.owner.id);
      // The others are told, but not the one who collected it.
      expect(
        (await notifications(home.member.id, 'parcel.collected')).filter(
          (n) => n.targetId === id,
        ),
      ).toHaveLength(1);
      expect(
        (await notifications(home.owner.id, 'parcel.collected')).filter(
          (n) => n.targetId === id,
        ),
      ).toEqual([]);
      // The guard's view never says who.
      const detail = await call(w, 'GET', `/gate/parcels/${id}`, {
        token: guard,
      });
      expect(detail.text).not.toContain(home.owner.id);
      expect(detail.text).not.toContain('resident_qr_recipient');
    });

    it('a member of the household may too', async () => {
      const { home, id } = await sceneWith();
      const phone = await entry.issue(home.member.token);
      await entry.inSafeWindow();
      const res = await handover(id, { residentQr: entry.qr(phone) });
      expect(res.status).toBe(200);
      expect((await row(id)).handedToId).toBe(home.member.id);
    });

    it('only an occupant of that unit: another unit’s resident, a forged QR and another compound’s are one answer', async () => {
      const { id } = await scene();
      const stranger = await entry.resident();
      const strangerPhone = await entry.issue(stranger.token);
      const foreign = await entry.foreignCredential();
      await entry.inSafeWindow();
      const forged = entry
        .qr(strangerPhone)
        .replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
      const answers = new Set<string>();
      for (const residentQr of [
        entry.qr(strangerPhone),
        forged,
        entry.qr(foreign),
        'JWR2.nonsense',
        'nonsense',
      ]) {
        const g = await s.guardOnDuty(w.a);
        const res = await handover(id, { residentQr }, g.token);
        answers.add(JSON.stringify({ status: res.status, body: omit(res) }));
      }
      expect([...answers]).toHaveLength(1);
      expect(JSON.parse([...answers][0])).toMatchObject({
        status: 403,
        body: { code: 'PARCEL_CODE_INVALID' },
      });
      expect((await row(id)).status).toBe('held');
    });

    it('a landlord has no phone, a revoked phone is dead, and a phone opens only its own unit’s parcels', async () => {
      // A tenant lives in the rented unit; the landlord does not.
      const rentedCode = (
        await asManager(() =>
          w.helpers.prisma.tenant.unit.findUniqueOrThrow({
            where: { id: w.a.rentedUnitId },
          }),
        )
      ).code;
      const rented = await s.receive(rentedCode);
      // A phone registered by the tenant opens the rented unit's parcel.
      const tenantPhone = await entry.issue(w.a.tokens.tenant);
      // The landlord has no entry QR at all (not a resident): NOT_A_RESIDENT.
      expect(
        (
          await call(w, 'POST', '/me/entry-credentials', {
            token: w.a.tokens.landlord,
            body: {},
          })
        ).status,
      ).toBe(403);
      // A phone of the household's, revoked, is just a dead QR.
      const { home, id } = await scene();
      const phone = await entry.issue(home.owner.token);
      await call(w, 'POST', `/me/entry-credentials/${phone.id}/revoke`, {
        token: home.owner.token,
      }).expect(204);
      await entry.inSafeWindow();
      const g1 = await s.guardOnDuty(w.a);
      expect(
        outcome(await handover(id, { residentQr: entry.qr(phone) }, g1.token)),
      ).toEqual({ status: 403, code: 'PARCEL_CODE_INVALID' });
      // The tenant's phone does not open the other household's parcel, and
      // opens its own.
      const g2 = await s.guardOnDuty(w.a);
      expect(
        outcome(
          await handover(id, { residentQr: entry.qr(tenantPhone) }, g2.token),
        ),
      ).toEqual({ status: 403, code: 'PARCEL_CODE_INVALID' });
      expect(
        (
          await handover(
            rented.id,
            { residentQr: entry.qr(tenantPhone) },
            g2.token,
          )
        ).status,
      ).toBe(200);
    });

    it('a genuine QR whose time has passed says so; the same QR from long ago is just unknown', async () => {
      const { home, id } = await scene();
      const phone = await entry.issue(home.owner.token);
      await entry.inSafeWindow();
      const stale = entry.qr(phone, -5);
      const res = await handover(id, { residentQr: stale });
      expect(outcome(res)).toEqual({ status: 403, code: 'PARCEL_QR_EXPIRED' });
      // A stale QR is not a wrong guess: it does not count towards a lockout.
      for (let n = 0; n < 6; n++)
        expect(outcome(await handover(id, { residentQr: stale })).code).toBe(
          'PARCEL_QR_EXPIRED',
        );
      expect((await row(id)).status).toBe('held');
    });
  });

  // --------------------------------------------------------------------------
  describe('by a delegate', () => {
    it('the lookup names the delegate, and only after a valid delegate code', async () => {
      const { home, id } = await scene({ labelName: 'PII-DELEG-label' });
      await authorize(home.owner.token, id, 'Karim Adel').then((r) =>
        expect(r.status).toBe(201),
      );
      const holder = await holderCode(id);
      const delegate = await delegateSecret(id);

      const viaHolder = await lookup({ code: holder.code });
      expect(viaHolder.body).toMatchObject({
        result: 'valid',
        presentedBy: 'holder',
        delegateName: null,
      });
      for (const way of [{ code: delegate.code }, { qr: delegate.qrPayload }]) {
        const looked = await lookup(way);
        expect(looked.body).toMatchObject({
          result: 'valid',
          presentedBy: 'delegate',
          delegateName: 'Karim Adel',
          parcel: { id },
        });
      }
      // Nowhere else does the guard see the name, nor the label.
      const detail = await call(w, 'GET', `/gate/parcels/${id}`, {
        token: guard,
      });
      const list = await call(w, 'GET', '/gate/parcels', {
        token: guard,
        query: { unitCode: home.unitCode },
      });
      for (const text of [detail.text, list.text, viaHolder.text]) {
        expect(text).not.toContain('Karim');
        expect(text).not.toContain('PII-DELEG');
      }
    });

    it('hands it over: method delegate, the name once, kept for the residents, then everyone is told', async () => {
      const { home, id } = await sceneWith({ carrier: 'jumia', pieces: 4 });
      await authorize(home.member.token, id, 'Karim Adel').then((r) =>
        expect(r.status).toBe(201),
      );
      const delegate = await delegateSecret(id);
      const res = await handover(id, { code: delegate.code });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'handed_over',
        delegateName: 'Karim Adel',
      });
      expect(await row(id)).toMatchObject({
        handedOverMethod: 'delegate',
        handedToId: null,
      });
      expect(await events(id)).toMatchObject([
        { kind: 'received' },
        { kind: 'delegate_authorized' },
        { kind: 'handed_over', method: 'delegate' },
      ]);
      // Both credentials ended; the delegate's name stays for the 30 days.
      expect(
        (await credentials(id)).map((c) => [
          c.kind,
          c.endReason,
          c.delegateName,
        ]),
      ).toEqual([
        ['holder', 'handed_over', null],
        ['delegate', 'handed_over', 'Karim Adel'],
      ]);
      // The unit sees who collected it; the guard's views do not.
      const mine = await call(w, 'GET', `/me/parcels/${id}`, {
        token: home.owner.token,
      });
      expect(mine.body).toMatchObject({
        status: 'handed_over',
        handedOverMethod: 'delegate',
        delegate: { name: 'Karim Adel', code: null, qrPayload: null },
      });
      const detail = await call(w, 'GET', `/gate/parcels/${id}`, {
        token: guard,
      });
      expect(detail.text).not.toContain('Karim');
      // All the unit's residents are told, the authorizer too.
      for (const who of [home.owner.id, home.member.id])
        expect(
          (await notifications(who, 'parcel.collected')).filter(
            (n) => n.targetId === id,
          ),
        ).toMatchObject([{ params: { method: 'delegate', carrier: 'jumia' } }]);
      // A replay of the hand-over re-renders the name from the parcel.
      const replay = await handover(id, { code: delegate.code }, guard);
      expect(outcome(replay).status).toBe(409);
    });

    it('a revoked, a rejected and a handed-over parcel’s delegate code is dead', async () => {
      const a = await scene();
      await authorize(a.home.owner.token, a.id);
      const aCode = (await delegateSecret(a.id)).code;
      await revoke(a.home.owner.token, a.id);
      const b = await scene();
      await authorize(b.home.owner.token, b.id);
      const bCode = (await delegateSecret(b.id)).code;
      await reject(b.home.owner.token, b.id);
      for (const [id, code] of [
        [a.id, aCode],
        [b.id, bCode],
      ]) {
        const g = await s.guardOnDuty(w.a);
        expect((await lookup({ code }, g.token)).body).toMatchObject({
          result: 'invalid',
        });
        // Against its own parcel: revoked is just unknown; rejected is a conflict.
        const res = await handover(id, { code }, g.token);
        expect(res.status).toBe(id === a.id ? 403 : 409);
      }
    });
  });

  // --------------------------------------------------------------------------
  describe('returning to the carrier', () => {
    it('a rejected parcel goes back with the reason `rejected`; credentials stay dead', async () => {
      const { home, id } = await scene();
      await reject(home.owner.token, id, 'not_ours');
      const res = await returned(id);
      expect(res.status).toBe(200);
      expect(keyPaths(res.body)).toEqual(
        HANDED_OVER.filter((k) => k !== 'delegateName'),
      );
      expect(res.body).toMatchObject({ id, status: 'returned' });
      const done = await row(id);
      expect(done).toMatchObject({
        status: 'returned',
        returnReason: 'rejected',
        rejectReason: 'not_ours',
      });
      expect(done.closedAt).toEqual(done.returnedAt);
      expect(await events(id)).toMatchObject([
        { kind: 'received' },
        { kind: 'rejected' },
        {
          kind: 'returned',
          actorSide: 'guard',
          actorId: guardId,
          reasonCode: 'rejected',
        },
      ]);
      const [audit] = await auditReaders(h).tenant(w.a.tenantId, {
        action: 'parcel.returned',
        targetId: id,
      });
      expect(audit).toMatchObject({
        actorId: guardId,
        metadata: { reasonCode: 'rejected' },
      });
    });

    it('an unclaimed one only after the manager days, with the reason `unclaimed`', async () => {
      const { id } = await scene();
      const early = await returned(id);
      expect(outcome(early)).toEqual({
        status: 409,
        code: 'PARCEL_NOT_YET_RETURNABLE',
      });
      expect(err(early).params).toEqual({ days: 14 });
      // 13 days is not enough, 14 is.
      await inA(
        `UPDATE parcels SET received_at = now() - interval '13 days' WHERE id = $1`,
        [id],
      );
      expect((await returned(id)).status).toBe(409);
      await inA(
        `UPDATE parcels SET received_at = now() - interval '15 days' WHERE id = $1`,
        [id],
      );
      const res = await returned(id);
      expect(res.status).toBe(200);
      expect(await row(id)).toMatchObject({
        status: 'returned',
        returnReason: 'unclaimed',
        rejectedAt: null,
      });
      const [audit] = await auditReaders(h).tenant(w.a.tenantId, {
        action: 'parcel.returned',
        targetId: id,
      });
      expect(audit.metadata).toEqual({ reasonCode: 'unclaimed' });
    });

    it('Idempotency-Key: a retry answers the same', async () => {
      const { home, id } = await scene();
      await reject(home.owner.token, id);
      const send = () =>
        call(w, 'POST', `/gate/parcels/${id}/return`, { token: guard }).set(
          'Idempotency-Key',
          `return-${id}`,
        );
      const first = await send();
      const again = await send();
      expect([first.status, again.status]).toEqual([200, 200]);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body).toEqual(first.body);
      expect(
        (await events(id)).filter((e) => e.kind === 'returned'),
      ).toHaveLength(1);
    });

    it('another compound’s parcel is not found', async () => {
      expect(outcome(await returned(w.bParcelId))).toEqual({
        status: 404,
        code: 'PARCEL_NOT_FOUND',
      });
      expect(outcome(await handover(w.bParcelId, { code: '123456' }))).toEqual({
        status: 404,
        code: 'PARCEL_NOT_FOUND',
      });
    });
  });

  /** Raw SQL in B as the table owner. */
  async function inB(sql: string, params: unknown[] = []) {
    await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [
      w.b.tenantId,
    ]);
    return db.query(sql, params);
  }
});

/** A response body without the volatile parts, to compare answers. */
function omit(res: Response): unknown {
  const body = res.body as Record<string, unknown>;
  const { requestId: _r, timestamp: _t, path: _p, ...rest } = body;
  void _r;
  void _t;
  void _p;
  return rest;
}
