import { expect, test } from 'playwright/test';
import { ar, en, watch } from './helpers.ts';

test('the landing page is Arabic and right-to-left, and switches to English in place', async ({ page }) => {
  const res = await page.goto('/');
  expect(res?.status()).toBe(200);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 2, name: ar['landing.download'] })).toBeVisible();

  await page.getByRole('button', { name: ar['lang.switch'] }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading', { level: 2, name: en['landing.download'] })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
  expect(await page.context().cookies()).toEqual([]);
});

test('pages are not cached, framed, referred or indexed, and run only nonce scripts', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  for (const path of ['/', '/v', '/a/not-me', '/a/export', '/i', '/r']) {
    const res = await page.goto(path);
    const headers = res!.headers();
    expect(headers['cache-control'], path).toContain('no-store');
    expect(headers['referrer-policy'], path).toBe('no-referrer');
    expect(headers['x-robots-tag'], path).toBe('noindex');
    expect(headers['x-frame-options'], path).toBe('DENY');
    expect(headers['set-cookie'], path).toBeUndefined();
    const csp = headers['content-security-policy'] ?? '';
    expect(csp, path).toContain("default-src 'none'");
    expect(csp, path).toContain("frame-ancestors 'none'");
    expect(csp, path).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic';/);
    expect(csp, path).not.toContain('unsafe');
    expect(csp, path).not.toMatch(/https?:/);
  }
  // A policy violation is a console error: none on any page.
  expect(errors).toEqual([]);
});

test('every request stays on this origin', async ({ page }) => {
  const seen = watch(page);
  await page.goto('/');
  await page.goto('/r');
  const origin = new URL(page.url()).origin;
  for (const url of seen.urls) expect(new URL(url).origin).toBe(origin);
});

test('a link page without a fragment, and an unknown page, show the invalid-link page', async ({ page }) => {
  for (const path of ['/v', '/a/not-me', '/a/export', '/i', '/r']) {
    const seen = watch(page);
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: ar['invalid.title'] })).toBeVisible();
    expect(seen.posts, path).toEqual([]);
  }
  const res = await page.goto('/a');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1, name: ar['invalid.title'] })).toBeVisible();
});

test('a malformed fragment is stripped and never sent', async ({ page }) => {
  const seen = watch(page);
  await page.goto('/v#not-a-token?x=1');
  await expect(page.getByRole('heading', { level: 1, name: ar['invalid.title'] })).toBeVisible();
  expect(page.url()).not.toContain('#');
  expect(seen.posts).toEqual([]);
});

test('the proxy refuses what is not one of its routes, or not from this page', async ({ request }) => {
  const json = { 'content-type': 'application/json', 'x-jiwar-bff': '1' };
  expect((await request.post('/api/auth/otp/request', { headers: json, data: { identifier: 'a@b.c' } })).status()).toBe(404);
  expect((await request.post('/api/public/not-me', { headers: { 'content-type': 'application/json' }, data: {} })).status()).toBe(403);
  expect(
    (await request.post('/api/public/not-me', { headers: { ...json, origin: 'https://evil.example' }, data: {} })).status(),
  ).toBe(403);
  expect((await request.get('/api/public/not-me')).status()).toBe(405);
  const refused = await request.post('/api/public/not-me', { headers: json, data: { token: 5, extra: 1 } });
  expect(refused.status()).toBe(400);
  const body = (await refused.json()) as Record<string, unknown>;
  expect(body.code).toBe('VALIDATION_FAILED');
  // The API's developer text and path are not relayed.
  expect(body.message).toBeUndefined();
  expect(body.path).toBeUndefined();
  expect(refused.headers()['cache-control']).toBe('no-store');
});
