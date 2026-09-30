import { nationalIdFor, uniqueSuffix } from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { waitForOtp } from '../setup/mailpit';
import { keyPaths, listKeys } from './keys';
import { call, err } from './request';
import { buildWorld, type World } from './world';

const PENDING = [
  'conflicts',
  'createdAt',
  'email',
  'fullName',
  'id',
  'occupancyType',
  'phone',
  'resides',
  'unitCode',
  'unitId',
];

describe('API v0 — self-registration (manager)', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  const manager = () => w.a.tokens.manager;

  async function registerThrough(linkToken: string, unitCode: string) {
    const documentNumber = nationalIdFor();
    const body = {
      linkToken,
      fullName: `Registrant ${uniqueSuffix()}`,
      unitCode,
      phone: uniquePhone(),
      email: uniqueEmail('reg'),
      idDocumentType: 'national_id',
      idDocumentNumber: documentNumber,
      occupancyType: 'owner',
    };
    const since = new Date();
    await call(w, 'POST', '/registrations/start', { body }).expect(202);
    const code = await waitForOtp(body.email, since);
    await call(w, 'POST', '/registrations/complete', {
      body: { ...body, code },
    }).expect(202);
    return { ...body, documentNumber };
  }

  it('links: created once (no-store), listed without the token, revoked by id', async () => {
    const created = await call(w, 'POST', '/registration-links', {
      token: manager(),
    }).expect(201);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(keyPaths(created.body)).toEqual(['createdAt', 'id', 'token']);
    const { id, token } = created.body as { id: string; token: string };

    const list = await call(w, 'GET', '/registration-links', {
      token: manager(),
    }).expect(200);
    expect(keyPaths(list.body)).toEqual(
      listKeys(['createdAt', 'id', 'revokedAt']),
    );
    expect(JSON.stringify(list.body)).not.toContain(token);

    await call(w, 'POST', `/registration-links/${id}/revoke`, {
      token: manager(),
    }).expect(204);
    const again = await call(w, 'POST', `/registration-links/${id}/revoke`, {
      token: manager(),
    });
    expect(err(again).code).toBe('REGISTRATION_LINK_NOT_FOUND');
  });

  it('requests: listed with conflicts, approved, rejected', async () => {
    const { token } = (
      await call(w, 'POST', '/registration-links', { token: manager() }).expect(
        201,
      )
    ).body as { token: string };
    const unit = await w.helpers.unit(w.a);
    const first = await registerThrough(token, unit.code);
    const second = await registerThrough(token, 'NOT-A-UNIT');

    const list = await call(w, 'GET', '/registrations', {
      token: manager(),
    }).expect(200);
    expect(keyPaths(list.body)).toEqual(listKeys(PENDING));
    const body = JSON.stringify(list.body);
    expect(body).not.toContain(first.documentNumber);
    const items = (
      list.body as {
        data: { id: string; email: string; conflicts: string[] }[];
      }
    ).data;
    const a = items.find((p) => p.email === first.email)!;
    const b = items.find((p) => p.email === second.email)!;
    expect(b.conflicts).toContain('unit_not_found');

    const approved = await call(w, 'POST', `/registrations/${a.id}/approve`, {
      token: manager(),
      body: {},
    }).expect(200);
    expect(keyPaths(approved.body)).toEqual(['accountId', 'occupancyId']);

    const conflict = await call(w, 'POST', `/registrations/${b.id}/approve`, {
      token: manager(),
      body: {},
    });
    expect(err(conflict).code).toBe('REGISTRATION_CONFLICT');

    await call(w, 'POST', `/registrations/${b.id}/reject`, {
      token: manager(),
      body: { reasonCode: 'unit_mismatch', reason: 'No such unit here' },
    }).expect(204);
    const after = await call(w, 'GET', '/registrations', {
      token: manager(),
    }).expect(200);
    const left = (after.body as { data: { id: string }[] }).data.map(
      (p) => p.id,
    );
    expect(left).not.toContain(a.id);
    expect(left).not.toContain(b.id);
  });
});
