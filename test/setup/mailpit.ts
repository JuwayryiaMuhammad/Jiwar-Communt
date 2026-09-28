import { required } from './test-env';

interface MailpitSummary {
  ID: string;
  Created: string;
  To: { Address: string }[];
}

/**
 * Waits for the newest OTP email to `to` that arrived after `since`, and
 * returns the 6-digit code in it. Codes are issued after the HTTP response,
 * so the email may take a moment to land.
 */
export async function waitForOtp(
  to: string,
  since: Date,
  timeoutMs = 10_000,
): Promise<string> {
  const base = required('MAILPIT_API_URL');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${base}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=20`,
    );
    const body = (await res.json()) as { messages: MailpitSummary[] };
    const fresh = body.messages
      .filter((m) => new Date(m.Created) >= since)
      .sort((a, b) => b.Created.localeCompare(a.Created));
    if (fresh[0]) {
      const msg = (await (
        await fetch(`${base}/api/v1/message/${fresh[0].ID}`)
      ).json()) as {
        Text: string;
      };
      const code = /\b(\d{6})\b/.exec(msg.Text)?.[1];
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`No OTP email for ${to} within ${timeoutMs}ms`);
}

/** How many emails `to` received after `since` (after a short settle delay). */
export async function countEmails(
  to: string,
  since: Date,
  settleMs = 1_000,
): Promise<number> {
  await new Promise((r) => setTimeout(r, settleMs));
  const base = required('MAILPIT_API_URL');
  const res = await fetch(
    `${base}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=50`,
  );
  const body = (await res.json()) as { messages: MailpitSummary[] };
  return body.messages.filter((m) => new Date(m.Created) >= since).length;
}

export interface MailpitMessage {
  Subject: string;
  Text: string;
  HTML: string;
}

/** Waits for the newest email to `to` after `since` and returns it whole. */
export async function waitForMessage(
  to: string,
  since: Date,
  timeoutMs = 10_000,
): Promise<MailpitMessage> {
  const base = required('MAILPIT_API_URL');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${base}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=20`,
    );
    const body = (await res.json()) as { messages: MailpitSummary[] };
    const fresh = body.messages
      .filter((m) => new Date(m.Created) >= since)
      .sort((a, b) => b.Created.localeCompare(a.Created));
    if (fresh[0]) {
      return (await (
        await fetch(`${base}/api/v1/message/${fresh[0].ID}`)
      ).json()) as MailpitMessage;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`No email for ${to} within ${timeoutMs}ms`);
}
