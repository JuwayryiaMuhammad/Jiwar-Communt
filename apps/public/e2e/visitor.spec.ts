import { expect, test } from 'playwright/test';
import { ar, en, expectInvalidLink, openLink, seed, unknownVisitorToken } from './helpers.ts';

const s = seed();

test('an active pass shows its QR, code and window; the token leaves the address bar', async ({ page }) => {
  const link = await openLink(page, '/v', s.visitor.active);
  await expect(page.getByRole('img', { name: ar['visitor.qr.alt'] })).toBeVisible();
  await expect(page.locator('.gate-code__digits')).toHaveText(/^\d{6}$/);
  await expect(page.getByRole('status').first()).toHaveText(ar['visitor.state.active']);
  await expect(page.getByText(s.visitor.unitCode)).toBeVisible();
  await expect(page.getByText(ar['visitor.until'])).toBeVisible();

  expect(link.posts).toEqual([
    { path: '/api/public/visitor-passes/lookup', body: JSON.stringify({ token: s.visitor.active }) },
  ]);
  await link.assertSecret();

  // English in place: the pass is still there, nothing was fetched again.
  await page.getByRole('button', { name: ar['lang.switch'] }).click();
  await expect(page.getByRole('status').first()).toHaveText(en['visitor.state.active']);
  await expect(page.getByRole('img', { name: en['visitor.qr.alt'] })).toBeVisible();
  expect(link.posts).toHaveLength(1);

  // Memory only: a reload has no token and asks for the link again.
  // (The language choice is kept; the token is not.)
  await page.reload();
  await expectInvalidLink(page, en);
  expect(await page.evaluate(() => ({ ...localStorage }))).toEqual({ 'jiwar.locale': 'en' });
});

test('a second link opened in the same tab is read and stripped too', async ({ page }) => {
  await openLink(page, '/v', unknownVisitorToken());
  await expectInvalidLink(page);
  // Same path, new fragment: the browser loads nothing by itself.
  const link = await openLink(page, '/v', s.visitor.cancelled);
  await expect(page.getByRole('status').first()).toHaveText(ar['visitor.state.cancelled_host']);
  await link.assertSecret();
});

test('an expired pass says so and shows no code', async ({ page }) => {
  const link = await openLink(page, '/v', s.visitor.expired);
  await expect(page.getByRole('status').first()).toHaveText(ar['visitor.state.expired']);
  await expect(page.locator('.qr')).toHaveCount(0);
  await expect(page.locator('.gate-code')).toHaveCount(0);
  await expect(page.getByRole('button', { name: ar['visitor.notme.link'] })).toHaveCount(0);
  await link.assertSecret();
});

test('a pass the host cancelled says so', async ({ page }) => {
  await openLink(page, '/v', s.visitor.cancelled);
  await expect(page.getByRole('status').first()).toHaveText(ar['visitor.state.cancelled_host']);
  await expect(page.locator('.qr')).toHaveCount(0);
});

test('an unknown pass shows the invalid-link page', async ({ page }) => {
  const token = unknownVisitorToken();
  const link = await openLink(page, '/v', token);
  await expectInvalidLink(page);
  await link.assertSecret();
});

test('"not for me" asks first, then cancels the pass', async ({ page }) => {
  const token = s.visitor.wrongRecipient;
  const link = await openLink(page, '/v', token);
  await page.getByRole('button', { name: ar['visitor.notme.link'] }).click();
  await expect(page.getByRole('heading', { name: ar['visitor.notme.title'] })).toBeVisible();
  // Asking changed nothing: only the lookup has been sent.
  expect(link.posts).toHaveLength(1);

  await page.getByRole('button', { name: ar['visitor.notme.confirm'] }).click();
  await expect(page.getByRole('status')).toHaveText(ar['visitor.notme.done']);
  expect(link.posts[1]).toEqual({ path: '/api/public/visitor-passes/not-me', body: JSON.stringify({ token }) });
  await link.assertSecret();

  await openLink(page, '/v', token);
  await expect(page.getByRole('status').first()).toHaveText(ar['visitor.state.cancelled_wrong']);
});
