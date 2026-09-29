import { arabicMinutes, renderOtpEmail } from './otp-email.templates';

describe('OTP email templates', () => {
  it('renders Arabic right-to-left with the code in ASCII digits', () => {
    const email = renderOtpEmail('ar', '042917', 300);
    expect(email.subject).toBe('رمز الدخول إلى جوار');
    expect(email.html).toContain('lang="ar"');
    expect(email.html).toContain('dir="rtl"');
    expect(email.html).toContain('<p dir="ltr"');
    expect(email.html).toContain('042917');
    expect(email.text).toContain('042917');
    expect(email.text).toContain('5 دقائق');
  });

  it('renders English left-to-right', () => {
    const email = renderOtpEmail('en', '042917', 300);
    expect(email.subject).toBe('Your Jiwar login code');
    expect(email.html).toContain('lang="en"');
    expect(email.html).toContain('dir="ltr"');
    expect(email.text).toContain('042917');
    expect(email.text).toContain('5 minutes');
  });

  it('invite codes have their own wording in both languages', () => {
    const en = renderOtpEmail('en', '042917', 300, 'invite_accept');
    expect(en.subject).toBe('Your Jiwar invitation code');
    expect(en.text).toContain('accept the household invitation');
    expect(en.text).not.toContain('log in');
    const ar = renderOtpEmail('ar', '042917', 300, 'invite_accept');
    expect(ar.subject).toBe('رمز قبول الدعوة إلى جوار');
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.text).toContain('042917');
  });

  it.each([
    [1, 'دقيقة واحدة'],
    [2, 'دقيقتين'],
    [5, '5 دقائق'],
    [10, '10 دقائق'],
    [15, '15 دقيقة'],
  ])('Arabic minutes: %i → %s', (n, text) => {
    expect(arabicMinutes(n)).toBe(text);
  });
});
