import { communityHelpers, type Compound } from '../setup/community';
import { day } from '../setup/compound-clock';
import { buildExports, readArchive, stepUp } from '../setup/exports';
import { nationalIdFor } from '../setup/fixtures';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';

/**
 * The unit's papers in a personal-data export (ADR 0036, 0062, 0063):
 * contracts, vault documents, registrations, moves, proxies, clearances,
 * deposits and inspection requests — records, never another person's
 * details.
 */
describe('Data export — the unit’s papers', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let c: Compound;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
    c = await x.compound('Papers Export Court');
  }, 120_000);

  afterAll(() => h.close());

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const post = (token: string, path: string, body: object = {}) =>
    h.http().post(`${API}${path}`).set(bearer(token)).send(body);

  it('carries each section, with the account’s own records and nobody else’s details', async () => {
    const unit = await x.unit(c);
    const p = await x.resident(c, [unit.id]);
    const token = await h.tokenFor({
      sub: p.id,
      tid: c.tenantId,
      typ: 'resident',
    });
    // A proxy appointed, the unit closed, an inspection asked, a clearance.
    const proxyEmail = uniqueEmail('papers-proxy');
    await post(token, `/units/${unit.id}/proxies`, {
      fullName: 'Hidden Proxy Name',
      email: proxyEmail,
      phone: uniquePhone(),
      idDocumentType: 'national_id',
      idDocumentNumber: nationalIdFor(),
      scopes: ['inspections'],
      endsOn: day(60),
    }).expect(201);
    await post(token, `/units/${unit.id}/closed-mode`, { closed: true }).expect(
      204,
    );
    await post(token, `/units/${unit.id}/inspection-requests`, {
      preferredOn: day(3),
    }).expect(201);
    await post(token, `/units/${unit.id}/clearances`).expect(201);

    await stepUp(h, token, p.email);
    const id = (
      (await post(token, '/me/data-exports').expect(201)).body as {
        id: string;
      }
    ).id;
    await buildExports(h);
    const dl = await h
      .http()
      .get(`${API}/me/data-exports/${id}/download`)
      .set(bearer(token))
      .expect(200);
    const archive = await readArchive((dl.body as { url: string }).url);
    expect(archive.names).toEqual(
      expect.arrayContaining([
        'contracts.json',
        'unit-documents.json',
        'registrations.json',
        'moves.json',
        'proxies.json',
        'clearances.json',
        'deposits.json',
        'inspection-requests.json',
      ]),
    );
    const json = (name: string) =>
      JSON.parse(archive.text(name)) as Record<string, unknown>[];
    // The move-in planned when the occupancy began.
    expect(json('moves.json')).toEqual([
      expect.objectContaining({
        unitCode: unit.code,
        direction: 'in',
        status: 'planned',
      }),
    ]);
    expect(json('proxies.json')).toEqual([
      expect.objectContaining({
        unitCode: unit.code,
        side: 'appointed',
        scopes: ['inspections'],
        status: 'invited',
      }),
    ]);
    expect(archive.text('proxies.json')).not.toContain('Hidden Proxy Name');
    expect(archive.text('proxies.json')).not.toContain(proxyEmail);
    expect(json('inspection-requests.json')).toEqual([
      expect.objectContaining({ unitCode: unit.code, status: 'open' }),
    ]);
    expect(json('clearances.json')).toEqual([
      expect.objectContaining({ unitCode: unit.code }),
    ]);
    for (const empty of [
      'contracts.json',
      'unit-documents.json',
      'registrations.json',
      'deposits.json',
    ])
      expect(json(empty)).toEqual([]);
  });
});
