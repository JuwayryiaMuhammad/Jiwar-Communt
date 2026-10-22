import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, type Page } from 'playwright/test';
import { ar } from '../messages/ar.ts';
import { en } from '../messages/en.ts';

export { ar, en };

export type Seed = {
  api: string;
  mailpit: string;
  visitor: { active: string; wrongRecipient: string; expired: string; cancelled: string; unitCode: string };
  notMe: { token: string };
  export: { token: string; email: string };
  invite: { token: string; email: string };
  registration: { token: string; unitCode: string; email: string; phone: string; nationalId: string };
  desk: { token: string; revoked: string; unitCode: string; accept: { id: string; number: string }; decline: { id: string; number: string } };
};

export function seed(): Seed {
  const dir = process.env.WEB_SMOKE_DIR;
  if (!dir) throw new Error('WEB_SMOKE_DIR is not set');
  return JSON.parse(readFileSync(join(dir, 'seed.json'), 'utf8')) as Seed;
}

/** Well-formed tokens the API has never issued. */
export const unknownVisitorToken = () => randomBytes(32).toString('base64url');
export const unknownActionToken = () => `${randomUUID()}.${randomBytes(32).toString('hex')}`;

/** Every URL the page asked for, and every body it posted to /api. */
export function watch(page: Page) {
  const urls: string[] = [];
  const posts: { path: string; body: string }[] = [];
  page.on('request', (req) => {
    urls.push(req.url());
    const { pathname } = new URL(req.url());
    if (pathname.startsWith('/api/')) posts.push({ path: pathname, body: req.postData() ?? '' });
  });
  return { urls, posts };
}

/**
 * Open a link the way a person does, then check what every link page must
 * do: the fragment is gone from the address bar, and the token was in no URL.
 */
export async function openLink(page: Page, path: string, token: string) {
  const seen = watch(page);
  await page.goto(`${path}#${token}`);
  await expect.poll(() => page.url()).not.toContain('#');
  expect(new URL(page.url()).pathname).toBe(path);
  expect(await page.evaluate(() => window.location.hash)).toBe('');
  return {
    ...seen,
    /** The token never travelled in a URL, and no cookie or storage holds it. */
    async assertSecret() {
      for (const url of seen.urls) expect(url).not.toContain(token);
      expect(await page.context().cookies()).toEqual([]);
      const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
      expect(stored).not.toContain(token);
    },
  };
}

export async function expectInvalidLink(page: Page, messages: typeof ar = ar) {
  await expect(page.getByRole('heading', { level: 1, name: messages['invalid.title'] })).toBeVisible();
}

/** The newest 6-digit code emailed to `to` after `since` (Mailpit). */
export async function emailedCode(mailpit: string, to: string, since: Date): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=20`);
    const body = (await res.json()) as { messages: { ID: string; Created: string }[] };
    const fresh = body.messages
      .filter((m) => new Date(m.Created) >= since)
      .sort((a, b) => b.Created.localeCompare(a.Created));
    if (fresh[0]) {
      const message = (await (await fetch(`${mailpit}/api/v1/message/${fresh[0].ID}`)).json()) as { Text: string };
      const code = /\b(\d{6})\b/.exec(message.Text)?.[1];
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no code emailed to ${to}`);
}
