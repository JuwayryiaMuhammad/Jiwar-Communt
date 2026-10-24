import { expect, test, type Page } from 'playwright/test';
import { ar, en, expectInvalidLink, openLink, seed, unknownVisitorToken } from './helpers.ts';

const s = seed();

/** The card of one request, found by its number. */
const card = (page: Page, number: string) => page.locator('article').filter({ hasText: number });

test('the desk lists its requests with what each needs; the token leaves the address bar', async ({ page }) => {
  const link = await openLink(page, '/p', s.desk.token);
  await expect(page.getByRole('heading', { level: 1, name: `${ar['desk.title']} · سباركل` })).toBeVisible();
  for (const r of [s.desk.accept, s.desk.decline]) {
    const c = card(page, r.number);
    await expect(c.getByRole('status')).toHaveText(ar['desk.status.pending']);
    await expect(c.getByText(s.desk.unitCode)).toBeVisible();
    await expect(c.getByText('Web smoke')).toBeVisible();
  }
  expect(link.posts).toEqual([{ path: '/api/public/partner-desk/lookup', body: JSON.stringify({ token: s.desk.token }) }]);
  await link.assertSecret();

  // English in place, nothing fetched again.
  await page.getByRole('button', { name: ar['lang.switch'] }).click();
  await expect(card(page, s.desk.accept.number).getByRole('status')).toHaveText(en['desk.status.pending']);
  expect(link.posts).toHaveLength(1);
});

test('accepting asks first, then shows the gate pass for a window within two hours', async ({ page }) => {
  const { token } = s.desk;
  const link = await openLink(page, '/p', token);
  const c = card(page, s.desk.accept.number);
  await c.getByRole('button', { name: ar['desk.action.accept'] }).click();
  await c.getByLabel(ar['desk.staffCount']).selectOption('2');
  // Asking changed nothing: only the lookup has been sent.
  expect(link.posts).toHaveLength(1);

  await c.getByRole('button', { name: ar['desk.confirm'] }).click();
  await expect(c.getByRole('status')).toHaveText(ar['desk.status.accepted']);
  await expect(c.locator('.gate-code__digits')).toHaveText(/^\d{6}$/);
  expect(link.posts[1]).toEqual({
    path: `/api/public/partner-desk/requests/${s.desk.accept.id}/accept`,
    body: JSON.stringify({ token, staffCount: 2 }),
  });
  await link.assertSecret();
});

test('declining takes a reason after the confirming press', async ({ page }) => {
  const { token } = s.desk;
  const link = await openLink(page, '/p', token);
  const c = card(page, s.desk.decline.number);
  await c.getByRole('button', { name: ar['desk.action.decline'] }).click();
  await c.getByLabel(ar['desk.reason']).selectOption('out_of_area');
  expect(link.posts).toHaveLength(1);

  await c.getByRole('button', { name: ar['desk.confirm'] }).click();
  await expect(c.getByRole('status')).toHaveText(`${ar['desk.status.declined']} · ${ar['desk.reason.out_of_area']}`);
  await expect(c.getByRole('button', { name: ar['desk.action.accept'] })).toHaveCount(0);
  expect(link.posts[1]).toEqual({
    path: `/api/public/partner-desk/requests/${s.desk.decline.id}/decline`,
    body: JSON.stringify({ token, reasonCode: 'out_of_area' }),
  });
});

test('a rotated link and an unknown one both show the invalid-link page', async ({ page }) => {
  for (const token of [s.desk.revoked, unknownVisitorToken()]) {
    const link = await openLink(page, '/p', token);
    await expectInvalidLink(page);
    await link.assertSecret();
  }
});
