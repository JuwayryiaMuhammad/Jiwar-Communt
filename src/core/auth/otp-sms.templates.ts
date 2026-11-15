import type { Locale } from '../common/i18n/locale';
import { arabicMinutes } from './otp-email.templates';

/**
 * The login code as a text message, in Arabic or English (ADR 0013, 0095).
 * Short on purpose: Arabic is UCS-2, one segment holds 70 characters, and a
 * second segment doubles the price. The code is always ASCII digits, as in
 * the email, and the text names the app and carries no link, tenant or
 * account detail. No app hash for SMS autofill yet (open, ADR 0095).
 */
export function renderOtpSms(
  locale: Locale,
  code: string,
  ttlSeconds: number,
): string {
  const minutes = Math.max(1, Math.round(ttlSeconds / 60));
  return locale === 'ar'
    ? `جوار: رمز الدخول ${code}. صالح ${arabicMinutes(minutes)}. لا تشاركه مع أحد.`
    : `Jiwar: your login code is ${code}. It expires in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}. Do not share it.`;
}
