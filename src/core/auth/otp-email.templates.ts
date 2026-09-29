import type { OtpPurpose } from '@prisma/client';
import type { Locale } from '../common/i18n/locale';
import { emailPage, rtlText, type RenderedEmail } from '../mail/layout';

export type { RenderedEmail };

/**
 * One-time code email in Arabic (RTL) or English (ADR 0013). The code is
 * always ASCII digits so it can be copied and typed on any keyboard. No
 * tenant or account details: the email proves possession of the address and
 * nothing else. The purpose changes the wording only.
 */
export function renderOtpEmail(
  locale: Locale,
  code: string,
  ttlSeconds: number,
  purpose: OtpPurpose = 'login',
): RenderedEmail {
  const minutes = Math.max(1, Math.round(ttlSeconds / 60));
  return locale === 'ar'
    ? arabic(code, minutes, purpose)
    : english(code, minutes, purpose);
}

const EN = {
  login: {
    subject: 'Your Jiwar login code',
    intro: 'Your Jiwar login code is',
    ignore: 'If you did not try to log in, ignore this email.',
  },
  invite_accept: {
    subject: 'Your Jiwar invitation code',
    intro: 'Your code to accept the household invitation on Jiwar is',
    ignore: 'If you were not expecting an invitation, ignore this email.',
  },
} satisfies Record<OtpPurpose, Record<string, string>>;

const AR = {
  login: {
    subject: 'رمز الدخول إلى جوار',
    intro: 'رمز الدخول إلى جوار هو',
    ignore: 'إذا لم تحاول تسجيل الدخول، تجاهل هذه الرسالة.',
  },
  invite_accept: {
    subject: 'رمز قبول الدعوة إلى جوار',
    intro: 'رمز قبول دعوة الانضمام إلى الأسرة على جوار هو',
    ignore: 'إذا لم تكن تنتظر دعوة، تجاهل هذه الرسالة.',
  },
} satisfies Record<OtpPurpose, Record<string, string>>;

function english(
  code: string,
  minutes: number,
  purpose: OtpPurpose,
): RenderedEmail {
  const t = EN[purpose];
  const expires = `It expires in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
  return {
    subject: t.subject,
    text: `${t.intro} ${code}.\n\n${expires} ${t.ignore}`,
    html: emailPage(
      'en',
      `<p>${t.intro}:</p>${codeBlock(code)}<p>${expires}</p><p style="color:#666">${t.ignore}</p>`,
    ),
  };
}

function arabic(
  code: string,
  minutes: number,
  purpose: OtpPurpose,
): RenderedEmail {
  const t = AR[purpose];
  const expires = `تنتهي صلاحيته خلال ${arabicMinutes(minutes)}.`;
  return {
    subject: t.subject,
    text: rtlText([`${t.intro} ${code}`, '', `${expires} ${t.ignore}`]),
    html: emailPage(
      'ar',
      `<p>${t.intro}:</p>${codeBlock(code)}<p>${expires}</p><p style="color:#666">${t.ignore}</p>`,
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
