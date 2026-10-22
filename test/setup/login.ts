import type { AccountType } from '@prisma/client';
import { LoginAlerts } from '../../src/core/auth/login-alerts';
import { SessionService } from '../../src/core/auth/session.service';
import { API, type HttpHarness } from './http-app';
import { waitForOtp } from './mailpit';

export interface Verified {
  loginTicket: string;
  accounts: { accountId: string; tenantName: string; accountType: string }[];
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  accountId: string;
}

/** OTP request → code from Mailpit → verify. */
export async function requestAndVerify(
  h: HttpHarness,
  identifier: string,
  email: string,
): Promise<Verified> {
  const since = new Date();
  await h
    .http()
    .post(`${API}/auth/otp/request`)
    .send({ identifier })
    .expect(202);
  const code = await waitForOtp(email, since);
  const res = await h
    .http()
    .post(`${API}/auth/otp/verify`)
    .send({ identifier, code })
    .expect(200);
  return res.body as Verified;
}

/** The whole real login flow for one account. */
export async function loginViaOtp(
  h: HttpHarness,
  email: string,
  accountId: string,
): Promise<Tokens> {
  const verified = await requestAndVerify(h, email, email);
  const res = await h
    .http()
    .post(`${API}/auth/select-account`)
    .send({ loginTicket: verified.loginTicket, accountId })
    .expect(200);
  return res.body as Tokens;
}

/**
 * A login without the OTP flow: the device recorded, a session started on
 * it and the login written, as `POST /auth/select-account` does (ADR 0058).
 * Returns the session's id.
 */
export async function deviceLogin(
  h: Pick<HttpHarness, 'moduleRef'>,
  who: { accountId: string; tenantId: string },
  origin: { userAgent?: string | null; installId?: string | null },
  accountType: AccountType = 'resident',
): Promise<string> {
  const sessions = h.moduleRef.get(SessionService);
  return h.moduleRef
    .get(LoginAlerts)
    .recordLogin(who, origin, async (tx, knownDeviceId) => {
      const { sessionId } = await sessions.startIn(
        tx,
        { ...who, accountType },
        knownDeviceId,
      );
      return { sessionId, result: sessionId };
    });
}
