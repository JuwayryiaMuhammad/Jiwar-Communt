import { expect, test } from 'playwright/test';
import { ar, emailedCode, openLink, seed, unknownVisitorToken } from './helpers.ts';

const s = seed();

test.describe('/i', () => {
  test('an invite is accepted with the code emailed to the invited address', async ({ page }) => {
    const token = s.invite.token;
    const link = await openLink(page, '/i', token);
    await expect(page.getByRole('heading', { level: 1, name: ar['invite.title'] })).toBeVisible();
    expect(link.posts).toEqual([]);

    const since = new Date();
    await page.getByRole('button', { name: ar['invite.send'] }).click();
    await expect(page.getByRole('status')).toHaveText(ar['invite.sent']);
    const code = await emailedCode(s.mailpit, s.invite.email, since);

    await page.getByLabel(ar['common.code.label']).fill(code);
    await page.getByRole('button', { name: ar['invite.accept'] }).click();
    await expect(page.getByRole('heading', { level: 1, name: ar['invite.done.active.title'] })).toBeVisible();
    await expect(page.getByRole('status')).toHaveText(ar['invite.done.active.body']);

    expect(link.posts).toEqual([
      { path: '/api/invites/accept/start', body: JSON.stringify({ token }) },
      { path: '/api/invites/accept/complete', body: JSON.stringify({ token, code }) },
    ]);
    await link.assertSecret();
  });

  test('an expired or unknown invite is not told apart: the code is refused', async ({ page }) => {
    const link = await openLink(page, '/i', unknownVisitorToken());
    await page.getByRole('button', { name: ar['invite.send'] }).click();
    await expect(page.getByRole('status')).toHaveText(ar['invite.sent']);
    await page.getByLabel(ar['common.code.label']).fill('123456');
    await page.getByRole('button', { name: ar['invite.accept'] }).click();
    await expect(page.locator('.note--error')).toHaveText(ar['error.OTP_INVALID']);
    await link.assertSecret();
  });
});

test.describe('/r', () => {
  test('a refused form shows its field errors; a valid one is sent twice, the same, and received', async ({ page }) => {
    const r = s.registration;
    const link = await openLink(page, '/r', r.token);
    await expect(page.getByRole('heading', { level: 1, name: ar['reg.title'] })).toBeVisible();

    await page.getByLabel(ar['reg.fullName']).fill('منى عادل');
    await page.getByLabel(ar['reg.unitCode']).fill(r.unitCode);
    await page.getByLabel(ar['reg.phone']).fill(r.phone);
    await page.getByLabel(ar['reg.email']).fill(r.email);
    await page.getByLabel(ar['reg.idNumber']).fill('12345678901234');
    await page.getByRole('button', { name: ar['reg.send'] }).click();
    await expect(page.getByText(ar['field.INVALID_NATIONAL_ID'])).toBeVisible();
    await expect(page.getByLabel(ar['reg.idNumber'])).toHaveAttribute('aria-invalid', 'true');

    await page.getByLabel(ar['reg.idNumber']).fill(r.nationalId);
    const since = new Date();
    await page.getByRole('button', { name: ar['reg.send'] }).click();
    await expect(page.getByLabel(ar['common.code.label'])).toBeVisible();
    const code = await emailedCode(s.mailpit, r.email, since);

    await page.getByLabel(ar['common.code.label']).fill(code);
    await page.getByRole('button', { name: ar['reg.submit'] }).click();
    await expect(page.getByRole('heading', { level: 1, name: ar['reg.done.title'] })).toBeVisible();

    expect(link.posts.map((p) => p.path)).toEqual([
      '/api/registrations/start',
      '/api/registrations/start',
      '/api/registrations/complete',
    ]);
    const start = JSON.parse(link.posts[1]!.body) as Record<string, unknown>;
    const { code: sentCode, ...complete } = JSON.parse(link.posts[2]!.body) as Record<string, unknown>;
    expect(sentCode).toBe(code);
    expect(complete).toEqual(start);
    expect(start.linkToken).toBe(r.token);
    expect(start.preferredLocale).toBe('ar');
    await link.assertSecret();
  });

  test('an expired or unknown link is not told apart: the code is refused', async ({ page }) => {
    const r = s.registration;
    const link = await openLink(page, '/r', unknownVisitorToken());
    await page.getByLabel(ar['reg.fullName']).fill('Someone Else');
    await page.getByLabel(ar['reg.unitCode']).fill(r.unitCode);
    await page.getByLabel(ar['reg.phone']).fill('01012345678');
    await page.getByLabel(ar['reg.email']).fill(`nobody-${Date.now()}@example.test`);
    await page.getByLabel(ar['reg.idNumber']).fill(r.nationalId);
    await page.getByRole('button', { name: ar['reg.send'] }).click();
    await page.getByLabel(ar['common.code.label']).fill('123456');
    await page.getByRole('button', { name: ar['reg.submit'] }).click();
    await expect(page.locator('.note--error')).toHaveText(ar['error.OTP_INVALID']);
    await link.assertSecret();
  });
});
