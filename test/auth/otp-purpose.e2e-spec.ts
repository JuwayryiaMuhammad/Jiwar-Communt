import { randomBytes } from 'node:crypto';
import { IdentifierHasher } from '../../src/core/auth/identifier';
import { OtpService } from '../../src/core/auth/otp.service';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { waitForMessage, waitForOtp } from '../setup/mailpit';

/**
 * Login codes and invite-acceptance codes (ADR 0004, 0016) share the OTP
 * machinery but never each other's challenges: each carries its purpose.
 */
describe('OTP purposes', () => {
  let h: HttpHarness;
  let otp: OtpService;
  let hasher: IdentifierHasher;
  let globalDb: GlobalDbService;

  beforeAll(async () => {
    h = await createHttpHarness();
    otp = h.moduleRef.get(OtpService);
    hasher = h.moduleRef.get(IdentifierHasher);
    globalDb = h.moduleRef.get(GlobalDbService);
  });

  afterAll(() => h.close());

  const inviteKey = () =>
    hasher.hashIdentifier({
      type: 'email',
      value: `invite-key-${randomBytes(8).toString('hex')}@x.test`,
    });

  it('an invite code goes to exactly that email, with invite wording, and accepts once', async () => {
    const email = uniqueEmail('invitee');
    const key = inviteKey();
    const since = new Date();
    await otp.issueForInvite(key, email, 'en');
    const message = await waitForMessage(email, since);
    expect(message.Subject).toBe('Your Jiwar invitation code');
    const code = /\b(\d{6})\b/.exec(message.Text)![1];

    expect(await otp.verifyInvite(key, code)).toBe(true);
    expect(await otp.verifyInvite(key, code)).toBe(false); // consumed
  });

  it('an invite code never logs in, even under the same key', async () => {
    const email = uniqueEmail('invitee');
    const key = inviteKey();
    const since = new Date();
    await otp.issueForInvite(key, email, 'ar');
    const code = await waitForOtp(email, since);
    expect(await otp.verify(key, code)).toBeNull();
    // Still usable for its own purpose: the login attempt spent nothing.
    expect(await otp.verifyInvite(key, code)).toBe(true);
  });

  it('a login code never accepts an invite, and neither kind invalidates the other', async () => {
    const tenant = await h.createTenant('Purpose Court');
    const email = uniqueEmail('resident');
    await h.createAccount(tenant.id, {
      type: 'resident',
      email,
      phone: uniquePhone(),
    });
    const key = hasher.hashIdentifier({ type: 'email', value: email });

    // An invite challenge under the same key as the login identifier.
    let since = new Date();
    await otp.issueForInvite(key, email, 'en');
    const inviteCode = await waitForOtp(email, since);

    since = new Date();
    await h
      .http()
      .post(`${API}/auth/otp/request`)
      .send({ identifier: email })
      .expect(202);
    const loginCode = await waitForOtp(email, since);

    // The login request did not invalidate the invite challenge.
    const live = await globalDb.otpChallenge.findMany({
      where: { identifierHash: key, invalidatedAt: null, consumedAt: null },
      select: { purpose: true },
    });
    expect(live.map((c) => c.purpose).sort()).toEqual([
      'invite_accept',
      'login',
    ]);

    if (loginCode !== inviteCode) {
      expect(await otp.verifyInvite(key, loginCode)).toBe(false);
    }
    await h
      .http()
      .post(`${API}/auth/otp/verify`)
      .send({ identifier: email, code: loginCode })
      .expect(200);
    expect(await otp.verifyInvite(key, inviteCode)).toBe(true);
  });
});
