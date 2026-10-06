import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Locale } from '../common/i18n/locale';
import { EmailTemplates, type EmailDelivery } from '../mail/email-templates';
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
  deletionRequested: 'account.deletion_requested',
  deletionCancelled: 'account.deletion_cancelled',
  legalHoldPlaced: 'account.legal_hold_placed',
  erased: 'account.erased',
  erasureOverdue: 'account.erasure_overdue',
} as const;

type Key = (typeof ACCOUNT_EMAILS)[keyof typeof ACCOUNT_EMAILS];

const SOLE: EmailDelivery = {
  category: 'account_security',
  critical: false,
  soleRecord: true,
};

/**
 * How each account email is delivered (ADR 0036). A freeze is critical
 * (the account has no session left to read an inbox), and so is the
 * confirmation of a deletion request. The others are the only record of
 * their notice.
 */
const DELIVERY: Record<Key, EmailDelivery> = {
  'account.frozen': { ...SOLE, critical: true },
  'account.reactivated': SOLE,
  'account.deletion_requested': { ...SOLE, critical: true },
  'account.deletion_cancelled': SOLE,
  'account.legal_hold_placed': SOLE,
  'account.erased': SOLE,
  'account.erasure_overdue': SOLE,
};
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
  'account.deletion_requested': {
    ar: (p) => ({
      subject: 'طلب حذف حسابك على جوار',
      lead: `استلمنا طلب حذف حسابك في ${p.compoundName}. يمكنك التراجع حتى ${p.effectiveDate}، وبعدها تُحذف بياناتك الشخصية وتبقى السجلات المالية والتدقيقية دون هويتك.`,
    }),
    en: (p) => ({
      subject: 'Your Jiwar account deletion request',
      lead: `We received your request to delete your account in ${p.compoundName}. You can undo it until ${p.effectiveDate}; after that your personal data is erased, and financial and audit records stay without your identity.`,
    }),
  },
  'account.deletion_cancelled': {
    ar: (p) => ({
      subject: 'أُلغي طلب حذف حسابك على جوار',
      lead: `ألغيت طلب حذف حسابك في ${p.compoundName}. يبقى حسابك كما هو.`,
    }),
    en: (p) => ({
      subject: 'Your Jiwar account deletion was cancelled',
      lead: `You cancelled the deletion of your account in ${p.compoundName}. Your account stays as it is.`,
    }),
  },
  'account.legal_hold_placed': {
    ar: (p) => ({
      subject: 'حذف حسابك على جوار معلّق',
      lead: `حذف بياناتك في ${p.compoundName} معلّق لالتزام قانوني بالاحتفاظ بها. سنُعلمك عند رفع التعليق.`,
    }),
    en: (p) => ({
      subject: 'The erasure of your Jiwar account is on hold',
      lead: `Erasing your data in ${p.compoundName} is on hold because of a legal obligation to keep it. We will tell you when the hold is lifted.`,
    }),
  },
  'account.erased': {
    ar: (p) => ({
      subject: 'حُذف حسابك على جوار',
      lead: `حُذفت بياناتك الشخصية من ${p.compoundName}. تبقى السجلات المالية والتدقيقية دون هويتك، كما يلزم القانون.`,
    }),
    en: (p) => ({
      subject: 'Your Jiwar account was erased',
      lead: `Your personal data in ${p.compoundName} was erased. Financial and audit records stay without your identity, as the law requires.`,
    }),
  },
  'account.erasure_overdue': {
    ar: (p) => ({
      subject: 'طلب حذف حساب متأخر على جوار',
      lead: `طلب حذف حساب في ${p.compoundName} (طلب ${p.requestId}) انتهت مهلة تراجعه منذ ${p.days} يوماً ولم يُنفّذ بعد.`,
      help: 'راجع النطاق وتحقق من عدم وجود التزام قانوني ثم نفّذ الحذف.',
    }),
    en: (p) => ({
      subject: 'An account erasure is overdue on Jiwar',
      lead: `An account deletion in ${p.compoundName} (request ${p.requestId}) left its grace period ${p.days} days ago and has not been carried out.`,
      help: 'Review the scope, check for a legal hold, then erase.',
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
      this.templates.register(
        key,
        (locale, p) => renderAccountEmail(key, locale, p as Params),
        DELIVERY[key],
      );
    }
  }
}
