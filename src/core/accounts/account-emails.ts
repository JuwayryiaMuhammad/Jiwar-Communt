import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Locale } from '../common/i18n/locale';
import { EmailTemplates } from '../mail/email-templates';
import {
  emailPage,
  escapeHtml,
  rtlText,
  type RenderedEmail,
} from '../mail/layout';

/** Outbox template keys owned by core accounts (ADR 0019, 0023). */
export const ACCOUNT_EMAILS = {
  frozen: 'account.frozen',
  reactivated: 'account.reactivated',
} as const;

type Key = (typeof ACCOUNT_EMAILS)[keyof typeof ACCOUNT_EMAILS];
type Params = Record<string, string> & { compoundName: string };

const TEXTS: Record<
  Key,
  Record<
    Locale,
    (p: Params) => { subject: string; lead: string; help?: string }
  >
> = {
  'account.frozen': {
    ar: (p) => ({
      subject: 'أُوقف حسابك على جوار',
      lead: `أُوقف حسابك في ${p.compoundName} لأن رقم الهاتف المسجّل عليه لم يعد لك، وأُزيل الرقم منه وانتهت كل الجلسات. لا يُفتح الحساب لصاحب الرقم الجديد بأي حال.`,
      help: 'تواصل مع إدارة المجمع لتسجيل رقم جديد وإعادة تفعيل حسابك.',
    }),
    en: (p) => ({
      subject: 'Your Jiwar account was frozen',
      lead: `Your account in ${p.compoundName} was frozen because its phone number is no longer yours. The number was removed and every session ended. The account is never opened for the number's new holder.`,
      help: 'Contact the compound management to register a new number and reactivate your account.',
    }),
  },
  'account.reactivated': {
    ar: (p) => ({
      subject: 'أُعيد تفعيل حسابك على جوار',
      lead: `أُعيد تفعيل حسابك في ${p.compoundName} برقم هاتف جديد. يمكنك الدخول الآن.`,
    }),
    en: (p) => ({
      subject: 'Your Jiwar account was reactivated',
      lead: `Your account in ${p.compoundName} was reactivated with a new phone number. You can log in now.`,
    }),
  },
};

export function renderAccountEmail(
  key: Key,
  locale: Locale,
  p: Params,
): RenderedEmail {
  const t = TEXTS[key][locale](p);
  const lines = [t.lead, ...(t.help ? ['', t.help] : [])];
  return {
    subject: t.subject,
    text: locale === 'ar' ? rtlText(lines) : lines.join('\n'),
    html: emailPage(
      locale,
      `<p>${escapeHtml(t.lead)}</p>${t.help ? `<p style="color:#666">${escapeHtml(t.help)}</p>` : ''}`,
    ),
  };
}

@Injectable()
export class AccountEmailTemplates implements OnModuleInit {
  constructor(private readonly templates: EmailTemplates) {}

  onModuleInit(): void {
    for (const key of Object.values(ACCOUNT_EMAILS)) {
      this.templates.register(key, (locale, p) =>
        renderAccountEmail(key, locale, p as Params),
      );
    }
  }
}
