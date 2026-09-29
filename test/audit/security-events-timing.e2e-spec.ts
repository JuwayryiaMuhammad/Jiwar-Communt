import { IdentifierHasher } from '../../src/core/auth/identifier';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { waitForOtp } from '../setup/mailpit';

/**
 * `otp.requested` must never make response time depend on whether an
 * identifier is registered, and a stuck security_events insert must never
 * hold back the code (ADR 0014: security events are fail-open).
 */
describe('otp.requested never blocks', () => {
  let h: HttpHarness;

  beforeAll(async () => {
    h = await createHttpHarness();
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(() => h.close());

  it('with the insert hung forever: both requests return at once, identically, and the code is still emailed', async () => {
    const tenant = await h.createTenant('Timing Court');
    const registered = uniqueEmail('timing');
    await h.createAccount(tenant.id, {
      type: 'resident',
      email: registered,
      phone: uniquePhone(),
    });
    const unregistered = uniqueEmail('nobody');

    const globalDb = h.moduleRef.get(GlobalDbService);
    const hung = jest
      .spyOn(globalDb, 'insertSecurityEvent')
      .mockImplementation(() => new Promise(() => undefined));

    const request = async (identifier: string) => {
      const started = Date.now();
      const res = await h
        .http()
        .post(`${API}/auth/otp/request`)
        .send({ identifier });
      return { res, ms: Date.now() - started };
    };

    const since = new Date();
    const known = await request(registered);
    const unknown = await request(unregistered);

    for (const r of [known, unknown]) {
      expect(r.res.status).toBe(202);
      expect(r.ms).toBeLessThan(1000);
    }
    expect(unknown.res.text).toBe(known.res.text);

    // The email goes out even though the event insert never finishes.
    expect(await waitForOtp(registered, since)).toMatch(/^\d{6}$/);

    // Both identifiers took the same path: an otp.requested write for each,
    // with no account attached in either case.
    const hasher = h.moduleRef.get(IdentifierHasher);
    const writes = hung.mock.calls
      .map(([data]) => data)
      .filter((d) => d.event === 'otp.requested');
    expect(writes.map((d) => d.identifierHash).sort()).toEqual(
      [registered, unregistered]
        .map((e) => hasher.hashIdentifier({ type: 'email', value: e }))
        .sort(),
    );
    expect(writes.every((d) => d.accountId === null)).toBe(true);
  });
});
