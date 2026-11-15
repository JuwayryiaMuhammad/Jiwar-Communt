import { renderOtpSms } from './otp-sms.templates';

describe('renderOtpSms', () => {
  it('says the code, how long it lasts and not to share it, in English', () => {
    const text = renderOtpSms('en', '123456', 300);
    expect(text).toContain('123456');
    expect(text).toContain('5 minutes');
    expect(text).toMatch(/do not share/i);
    expect(renderOtpSms('en', '123456', 60)).toContain('1 minute.');
  });

  it('says it in Arabic with the code in ASCII digits', () => {
    const text = renderOtpSms('ar', '123456', 300);
    expect(text).toContain('123456');
    expect(text).toContain('5 دقائق');
    expect(text).toContain('لا تشاركه');
    expect(text).toMatch(/^جوار/);
  });

  it.each([60, 120, 300, 600, 900, 1800])(
    'fits one segment in both languages for a %s-second code',
    (ttl) => {
      // Arabic is UCS-2: one segment holds 70 characters. English (GSM-7)
      // holds 160.
      expect(renderOtpSms('ar', '123456', ttl).length).toBeLessThanOrEqual(70);
      expect(renderOtpSms('en', '123456', ttl).length).toBeLessThanOrEqual(160);
    },
  );

  it('carries no link and nothing about the account', () => {
    for (const locale of ['ar', 'en'] as const) {
      expect(renderOtpSms(locale, '123456', 300)).not.toMatch(
        /https?:|www\.|@/,
      );
    }
  });
});
