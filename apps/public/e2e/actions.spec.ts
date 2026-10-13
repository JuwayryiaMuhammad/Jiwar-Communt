import { expect, test } from 'playwright/test';
import { ar, emailedCode, expectInvalidLink, openLink, seed, unknownActionToken } from './helpers.ts';

const s = seed();

test.describe('/a/not-me', () => {
  test('nothing is sent before the confirming press; then the account is frozen, once', async ({ page }) => {
    const token = s.notMe.token;
    const link = await openLink(page, '/a/not-me', token);
    await expect(page.getByRole('heading', { level: 1, name: ar['notme.title'] })).toBeVisible();
    await expect(page.getByText(ar['notme.effect.freeze'])).toBeVisible();
    expect(link.posts).toEqual([]);

    await page.getByRole('button', { name: ar['notme.confirm'] }).click();
    await expect(page.getByRole('heading', { level: 1, name: ar['notme.done.title'] })).toBeVisible();
    expect(link.posts).toEqual([{ path: '/api/public/not-me', body: JSON.stringify({ token }) }]);
    await link.assertSecret();

    // The link works once.
    await openLink(page, '/a/not-me', token);
    await page.getByRole('button', { name: ar['notme.confirm'] }).click();
    await expectInvalidLink(page);
  });

  test('an expired or unknown link shows the invalid-link page after the press', async ({ page }) => {
    const link = await openLink(page, '/a/not-me', unknownActionToken());
    await page.getByRole('button', { name: ar['notme.confirm'] }).click();
    await expectInvalidLink(page);
    await link.assertSecret();
  });
});

test.describe('/a/export', () => {
  test('a code is sent on request, a wrong one is refused, the right one downloads', async ({ page }) => {
    const token = s.export.token;
    const link = await openLink(page, '/a/export', token);
    await expect(page.getByRole('heading', { level: 1, name: ar['export.title'] })).toBeVisible();
    expect(link.posts).toEqual([]);

    const since = new Date();
    await page.getByRole('button', { name: ar['export.send'] }).click();
    await expect(page.getByRole('status')).toHaveText(ar['export.sent']);
    const code = await emailedCode(s.mailpit, s.export.email, since);

    const field = page.getByLabel(ar['common.code.label']);
    await field.fill(code === '000000' ? '111111' : '000000');
    await page.getByRole('button', { name: ar['export.download'], exact: true }).click();
    await expect(page.locator('.note--error')).toHaveText(ar['error.STEP_UP_CODE_INVALID']);

    await field.fill(code);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: ar['export.download'], exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/^jiwar-export-\d{4}-\d{2}-\d{2}\.zip$/);
    await expect(page.getByRole('heading', { level: 1, name: ar['export.done.title'] })).toBeVisible();

    expect(link.posts.map((p) => p.path)).toEqual([
      '/api/public/data-exports/code',
      '/api/public/data-exports/download',
      '/api/public/data-exports/download',
    ]);
    expect(link.posts[2]!.body).toBe(JSON.stringify({ token, code }));
    for (const url of link.urls) expect(url).not.toContain(token);
    expect(await page.context().cookies()).toEqual([]);
  });

  test('an expired or unknown link shows the invalid-link page after the press', async ({ page }) => {
    const link = await openLink(page, '/a/export', unknownActionToken());
    await page.getByRole('button', { name: ar['export.send'] }).click();
    await expectInvalidLink(page);
    await link.assertSecret();
  });
});
