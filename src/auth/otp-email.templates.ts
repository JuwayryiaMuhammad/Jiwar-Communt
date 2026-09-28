import type { Locale } from '../common/i18n/locale';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * OTP email in Arabic (RTL) or English (ADR 0013). The code is always ASCII
 * digits so it can be copied and typed on any keyboard. No tenant or account
 * details: the email proves possession of the address and nothing else.
 */
export function renderOtpEmail(
  locale: Locale,
  code: string,
  ttlSeconds: number,
): RenderedEmail {
  const minutes = Math.max(1, Math.round(ttlSeconds / 60));
  return locale === 'ar' ? arabic(code, minutes) : english(code, minutes);
}

function english(code: string, minutes: number): RenderedEmail {
  const expires = `It expires in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
  const ignore = 'If you did not try to log in, ignore this email.';
  return {
    subject: 'Your Jiwar login code',
    text: `Your Jiwar login code is ${code}.\n\n${expires} ${ignore}`,
    html: page(
      'en',
      'ltr',
      `<p>Your Jiwar login code is:</p>${codeBlock(code)}<p>${expires}</p><p style="color:#666">${ignore}</p>`,
    ),
  };
}

function arabic(code: string, minutes: number): RenderedEmail {
  const expires = `تنتهي صلاحيته خلال ${arabicMinutes(minutes)}.`;
  const ignore = 'إذا لم تحاول تسجيل الدخول، تجاهل هذه الرسالة.';
  return {
    subject: 'رمز الدخول إلى جوار',
    // U+200F RIGHT-TO-LEFT MARK keeps plain-text clients from flipping the line.
    text: `‏رمز الدخول إلى جوار هو ${code}\n\n‏${expires} ${ignore}`,
    html: page(
      'ar',
      'rtl',
      `<p>رمز الدخول إلى جوار هو:</p>${codeBlock(code)}<p>${expires}</p><p style="color:#666">${ignore}</p>`,
    ),
  };
}

/** Arabic plural forms for minutes (1, 2, 3–10, 11+). */
export function arabicMinutes(n: number): string {
  if (n === 1) return 'دقيقة واحدة';
  if (n === 2) return 'دقيقتين';
  if (n >= 3 && n <= 10) return `${n} دقائق`;
  return `${n} دقيقة`;
}

function codeBlock(code: string): string {
  // The code itself is always left-to-right, even inside an RTL email.
  return `<p dir="ltr" style="font-size:28px;font-weight:bold;letter-spacing:6px;margin:16px 0">${code}</p>`;
}

function page(lang: Locale, dir: 'rtl' | 'ltr', body: string): string {
  const align = dir === 'rtl' ? 'right' : 'left';
  return `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"></head><body dir="${dir}" style="direction:${dir};text-align:${align};font-family:Tahoma,Arial,sans-serif;font-size:16px">${body}</body></html>`;
}
