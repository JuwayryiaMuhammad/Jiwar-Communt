import { createHmac } from 'node:crypto';
import type { Client } from 'pg';
import type { Response } from 'supertest';
import { call } from '../api/request';
import type { World } from '../api/world';
import { gateHelpers } from './gate';
import { API, type HttpHarness } from './http-app';

export interface Credential {
  id: string;
  secret: string;
  stepSeconds: number;
}

export interface Person {
  id: string;
  token: string;
  unitId: string;
  fullName: string;
  phone: string;
  email: string;
  idDocumentNumber: string;
}

export interface Verified {
  result: 'valid' | 'invalid';
  subject: string | null;
  reason: string | null;
  subjectId: string | null;
  next: string | null;
  display: {
    unitCode: string | null;
    firstName: string | null;
    unitCodes: string[] | null;
    photoUrl: string | null;
  } | null;
}

export const STEP_MS = 30_000;
export const UNKNOWN_CODE = { code: '000000' };

/**

/**
 * The resident's entry QR in tests (ADR 0031): residents, phones, raw SQL in
 * compound A, and what a phone and a guard do. Call it inside `describe`,
 * with accessors for what `beforeAll` creates; `guard: true` gives every test
 * a fresh guard on duty (and so a fresh rate-limit budget).
 */
export function residentEntry(
  get: () => { h: HttpHarness; w: World; db: Client },
  options: { guard?: boolean } = {},
) {
  /** Raw SQL in A, as the table owner (FORCE RLS binds it too). */
  async function inA(sql: string, params: unknown[] = []) {
    await get().db.query(`SELECT set_config('app.tenant_id', $1, false)`, [
      get().w.a.tenantId,
    ]);
    return get().db.query(sql, params);
  }

  /** What the phone does: the QR for a step, from the secret it was given. */
  function qr(c: Credential, offset = 0, at = Date.now()): string {
    const step = Math.floor(at / STEP_MS) + offset;
    const mac = createHmac('sha256', Buffer.from(c.secret, 'base64url'))
      .update(`${c.id}.${step}`)
      .digest()
      .subarray(0, 16)
      .toString('base64url');
    return `JWR2.${c.id}.${step}.${mac}`;
  }

  /** A group of scans must not straddle a step: wait out the last seconds. */
  async function inSafeWindow() {
    const left = STEP_MS - (Date.now() % STEP_MS);
    if (left < 4000) await new Promise((r) => setTimeout(r, left + 200));
  }

  /** A guard of A with a fresh rate-limit budget, on duty at A's gate. */
  async function freshGuard(): Promise<string> {
    const g = await gateHelpers(get().h).guard(get().w.a);
    await gateHelpers(get().h).startShift(get().w.a, g.id, get().w.a.gateId);
    return get().w.tokenFor(get().w.a, g.id, 'staff');
  }
  let guardToken: string;
  if (options.guard)
    beforeEach(async () => {
      guardToken = await freshGuard();
    });

  const verify = (body: object, token = guardToken) =>
    call(get().w, 'POST', '/gate/verify', { token, body });
  const scan = async (c: Credential, offset = 0) =>
    (await verify({ qr: qr(c, offset) }).expect(200)).body as Verified;

  /** Status, headers a client sees, and the body. */
  function shape(res: Response): string {
    return JSON.stringify({
      status: res.status,
      type: res.headers['content-type'],
      length: res.headers['content-length'],
      cache: res.headers['cache-control'] ?? null,
      body: res.text,
    });
  }

  /** A resident living in a fresh unit of A (and of the units given). */
  async function resident(
    over: {
      fullName?: string;
      occupancyType?: 'owner' | 'tenant';
      resides?: boolean;
      extraUnits?: string[];
    } = {},
  ): Promise<Person> {
    const unit = await get().w.helpers.unit(get().w.a);
    const p = get().w.helpers.person('qr');
    const fullName = over.fullName ?? p.fullName;
    const created = await get().w.helpers.asManager(get().w.a, () =>
      get().w.helpers.residents.createResident({
        ...p,
        fullName,
        units: [unit.id, ...(over.extraUnits ?? [])].map((unitId) => ({
          unitId,
          occupancyType: over.occupancyType ?? 'owner',
          resides: over.resides,
        })),
      }),
    );
    return {
      id: created.id,
      unitId: unit.id,
      fullName,
      phone: p.phone,
      email: p.email,
      idDocumentNumber: p.idDocumentNumber,
      token: await get().w.tokenFor(get().w.a, created.id, 'resident'),
    };
  }

  const issueRes = (token: string, body: object = {}, key?: string) => {
    let req = get()
      .w.h.http()
      .post(`${API}/me/entry-credentials`)
      .set('Authorization', `Bearer ${token}`);
    if (key) req = req.set('Idempotency-Key', key);
    return req.send(body);
  };
  const issue = async (token: string, body: object = {}) =>
    (await issueRes(token, body).expect(201)).body as Credential;
  const live = async (accountId: string) =>
    (
      await inA(
        `SELECT id, device_name, revoked_at, revoke_reason
           FROM entry_credentials WHERE account_id = $1 ORDER BY created_at`,
        [accountId],
      )
    ).rows as {
      id: string;
      device_name: string | null;
      revoked_at: Date | null;
      revoke_reason: string | null;
    }[];
  const reasons = async (accountId: string) =>
    (await live(accountId)).map((r) => r.revoke_reason);
  const count = async (table: string) =>
    Number(
      (
        (await inA(`SELECT count(*) FROM ${table}`)).rows[0] as {
          count: string;
        }
      ).count,
    );

  /** A phone registered in the other compound, by a resident of its own. */
  async function foreignCredential(): Promise<Credential> {
    const unit = await get().w.helpers.unit(get().w.b);
    const r = await get().w.helpers.resident(get().w.b, [unit.id]);
    return issue(await get().w.tokenFor(get().w.b, r.id, 'resident'));
  }

  const asManager = <T>(fn: () => Promise<T>) =>
    get().w.helpers.asManager(get().w.a, fn);

  return {
    inA,
    qr,
    inSafeWindow,
    freshGuard,
    verify,
    scan,
    shape,
    resident,
    issueRes,
    issue,
    live,
    reasons,
    count,
    foreignCredential,
    asManager,
  };
}
