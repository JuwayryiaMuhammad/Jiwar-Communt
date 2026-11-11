import { nationalIdFor, uniqueSuffix } from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { keyPaths, listKeys } from './keys';
import { call } from './request';
import { buildWorld, type World } from './world';

const OCCUPANCY = [
  'endReason',
  'endedAt',
  'handedOverAt',
  'id',
  'isPrimary',
  'occupancyType',
  'resides',
  'startedAt',
  'status',
  'unitCode',
  'unitId',
];
const RESIDENT_DETAIL = [
  'birthDate',
  'email',
  'fullName',
  'id',
  'idDocumentNumberMasked',
  'idDocumentType',
  'nationality',
  'occupancies',
  ...OCCUPANCY.map((k) => `occupancies[].${k}`),
  'phone',
  'preferredLocale',
  'status',
].sort();
const ACCOUNT_LIST = [
  'createdAt',
  'email',
  'fullName',
  'id',
  'phone',
  'status',
  'type',
];
const ACCOUNT_DETAIL = [
  ...ACCOUNT_LIST,
  'birthDate',
  'idDocumentNumberMasked',
  'idDocumentType',
  'nationality',
].sort();

describe('API v0 — residents & accounts', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  const manager = () => w.a.tokens.manager;

  it('residents: create, list, detail, contact, another unit', async () => {
    const documentNumber = nationalIdFor();
    const created = await call(w, 'POST', '/residents', {
      token: manager(),
      body: {
        fullName: `Resident ${uniqueSuffix()}`,
        idDocumentType: 'national_id',
        idDocumentNumber: documentNumber,
        phone: uniquePhone(),
        email: uniqueEmail('res'),
        units: [{ unitId: w.a.rentedUnitId, occupancyType: 'tenant' }],
      },
    }).expect(201);
    expect(keyPaths(created.body)).toEqual(RESIDENT_DETAIL);
    expect(created.body).toMatchObject({
      idDocumentNumberMasked: `••••${documentNumber.slice(-4)}`,
    });
    const { id } = created.body as { id: string };

    const list = await call(w, 'GET', '/residents', {
      token: manager(),
    }).expect(200);
    expect(keyPaths(list.body)).toEqual(
      listKeys([
        'email',
        'fullName',
        'id',
        'phone',
        'status',
        'units',
        'units[].isPrimary',
        'units[].occupancyType',
        'units[].unitCode',
        'units[].unitId',
      ]),
    );
    expect(JSON.stringify(list.body)).not.toContain(documentNumber);

    const detail = await call(w, 'GET', `/residents/${id}`, {
      token: manager(),
    }).expect(200);
    expect(keyPaths(detail.body)).toEqual(RESIDENT_DETAIL);
    expect(JSON.stringify(detail.body)).not.toContain(documentNumber);

    const email = uniqueEmail('new');
    const contact = await call(w, 'PATCH', `/residents/${id}/contact`, {
      token: manager(),
      body: { email },
    }).expect(200);
    expect(contact.body).toMatchObject({ email });

    const unit = await w.helpers.unit(w.a);
    const added = await call(w, 'POST', `/residents/${id}/occupancies`, {
      token: manager(),
      body: { unitId: unit.id, occupancyType: 'owner' },
    }).expect(201);
    expect(keyPaths(added.body)).toEqual(OCCUPANCY);

    // Only resident accounts are residents.
    await call(w, 'GET', `/residents/${w.a.ids.family}`, {
      token: manager(),
    }).expect(404);
  });

  it('the account and resident lists search by part of the name, or exactly the phone or the email (ADR 0072)', async () => {
    const tag = `Finder ${uniqueSuffix()}`;
    const email = uniqueEmail('find');
    const phone = uniquePhone();
    const created = await call(w, 'POST', '/residents', {
      token: manager(),
      body: {
        fullName: `${tag} Hassan`,
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(),
        phone,
        email,
        units: [{ unitId: w.a.rentedUnitId, occupancyType: 'tenant' }],
      },
    }).expect(201);
    const { id } = created.body as { id: string };
    const ids = async (path: string, q: string) =>
      (
        (
          await call(w, 'GET', path, { token: manager(), query: { q } }).expect(
            200,
          )
        ).body as { data: { id: string }[] }
      ).data.map((r) => r.id);

    // A part of the name, in any case, in both lists.
    expect(await ids('/residents', tag.toUpperCase())).toEqual([id]);
    expect(await ids('/accounts', tag.toLowerCase())).toEqual([id]);
    // Exactly the email or the phone, and nothing near them.
    expect(await ids('/residents', email)).toEqual([id]);
    expect(await ids('/accounts', phone)).toEqual([id]);
    expect(await ids('/accounts', email.slice(0, -4))).toEqual([]);
    // A second one of the same name: a search pages like the list does, and
    // its next page continues the same search.
    const other = (
      await call(w, 'POST', '/residents', {
        token: manager(),
        body: {
          fullName: `${tag} Soliman`,
          idDocumentType: 'national_id',
          idDocumentNumber: nationalIdFor(),
          phone: uniquePhone(),
          email: uniqueEmail('find2'),
          units: [{ unitId: w.a.rentedUnitId, occupancyType: 'tenant' }],
        },
      }).expect(201)
    ).body as { id: string };
    const page = async (cursor?: string) =>
      (
        await call(w, 'GET', '/accounts', {
          token: manager(),
          query: { q: tag, limit: '1', ...(cursor ? { cursor } : {}) },
        }).expect(200)
      ).body as { data: { id: string }[]; nextCursor: string | null };
    const first = await page();
    expect(first.data).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await page(first.nextCursor!);
    expect([first.data[0].id, second.data[0].id].sort()).toEqual(
      [id, other.id].sort(),
    );
    expect(second.nextCursor).toBeNull();
    // One character is too little to search.
    await call(w, 'GET', '/residents', {
      token: manager(),
      query: { q: 'x' },
    }).expect(400);
  });

  it('accounts: list, detail, create, status, contact, freeze and recovery', async () => {
    const list = await call(w, 'GET', '/accounts', {
      token: manager(),
      query: { limit: '2' },
    }).expect(200);
    expect(keyPaths(list.body)).toEqual(listKeys(ACCOUNT_LIST));

    const documentNumber = nationalIdFor();
    const created = await call(w, 'POST', '/accounts', {
      token: manager(),
      body: {
        type: 'resident',
        fullName: `Account ${uniqueSuffix()}`,
        idDocumentType: 'national_id',
        idDocumentNumber: documentNumber,
        phone: uniquePhone(),
        email: uniqueEmail('acc'),
      },
    }).expect(201);
    expect(keyPaths(created.body)).toEqual(ACCOUNT_DETAIL);
    expect(JSON.stringify(created.body)).not.toContain(documentNumber);
    const { id } = created.body as { id: string };

    const got = await call(w, 'GET', `/accounts/${id}`, {
      token: manager(),
    }).expect(200);
    expect(keyPaths(got.body)).toEqual(ACCOUNT_DETAIL);

    const inactive = await call(w, 'PATCH', `/accounts/${id}/status`, {
      token: manager(),
      body: { status: 'inactive' },
    }).expect(200);
    expect(inactive.body).toMatchObject({ status: 'inactive' });
    await call(w, 'PATCH', `/accounts/${id}/status`, {
      token: manager(),
      body: { status: 'active' },
    }).expect(200);

    const frozen = await call(w, 'POST', `/accounts/${id}/freeze`, {
      token: manager(),
      body: { reasonCode: 'phone_reassigned', reason: 'Not me' },
    }).expect(200);
    expect(frozen.body).toMatchObject({ status: 'frozen', phone: null });

    const newPhone = uniquePhone();
    const contact = await call(w, 'PATCH', `/accounts/${id}/contact`, {
      token: manager(),
      body: { phone: newPhone },
    }).expect(200);
    expect(keyPaths(contact.body)).toEqual(ACCOUNT_DETAIL);
    const back = await call(w, 'POST', `/accounts/${id}/reactivate`, {
      token: manager(),
    }).expect(200);
    expect(back.body).toMatchObject({ status: 'active', phone: newPhone });
  });
});
