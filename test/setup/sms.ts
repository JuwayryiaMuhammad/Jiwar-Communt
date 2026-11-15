import {
  LogSmsSender,
  type LoggedSms,
} from '../../src/core/sms/log-sms.sender';
import { SMS_SENDER } from '../../src/core/sms/sms-sender';
import type { HttpHarness } from './http-app';

/**
 * The texts the app "sent" under SMS_PROVIDER=log, the way mailpit.ts reads
 * the emails it sent (ADR 0095). Needs `import '../setup/sms-env'` first in
 * the spec.
 */
export function smsLog(h: Pick<HttpHarness, 'moduleRef'>): LogSmsSender {
  const sender = h.moduleRef.get<unknown>(SMS_SENDER);
  if (!(sender instanceof LogSmsSender))
    throw new Error(
      "SMS_PROVIDER is not 'log': import '../setup/sms-env' first in the spec",
    );
  return sender;
}

function textsTo(
  h: Pick<HttpHarness, 'moduleRef'>,
  phone: string,
  since: Date,
): LoggedSms[] {
  return smsLog(h)
    .messages()
    .filter((m) => m.to === phone && m.at >= since);
}

/**
 * Waits for the newest text to `phone` after `since` and returns it with
 * the 6-digit code in it. Codes are issued after the HTTP response.
 */
export async function waitForSms(
  h: Pick<HttpHarness, 'moduleRef'>,
  phone: string,
  since: Date,
  timeoutMs = 10_000,
): Promise<{ code: string; body: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const newest = textsTo(h, phone, since).at(-1);
    const code = newest ? /\b(\d{6})\b/.exec(newest.body)?.[1] : undefined;
    if (newest && code) return { code, body: newest.body };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`No SMS for the number within ${timeoutMs}ms`);
}

/** How many texts `phone` received after `since` (after a short settle delay). */
export async function countSms(
  h: Pick<HttpHarness, 'moduleRef'>,
  phone: string,
  since: Date,
  settleMs = 1_000,
): Promise<number> {
  await new Promise((r) => setTimeout(r, settleMs));
  return textsTo(h, phone, since).length;
}
