import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Locale } from '../../core/common/i18n/locale';
import { EmailTemplates } from '../../core/mail/email-templates';
import {
  emailPage,
  escapeHtml,
  rtlText,
  type RenderedEmail,
} from '../../core/mail/layout';

/** Outbox template keys of the partners (ADR 0019, 0060). */
export const PARTNER_EMAILS = {
  /** To a partner's notify address: a request waits on its desk. */
  newRequest: 'partner_desk.new_request',
} as const;

/**
 * A request waits on the partner's desk. No resident data, no unit, no
 * link: the partner opens the desk link the management gave it.
 */
export function renderNewRequestEmail(
  locale: Locale,
  p: { compoundName: string },
): RenderedEmail {
  const t =
    locale === 'ar'
      ? {
          subject: `طلب خدمة جديد من ${p.compoundName}`,
          lead: `لديك طلب خدمة جديد من سكان ${p.compoundName}. افتح رابط مكتبك الذي أعطتك إياه الإدارة لترى الطلب وترد عليه.`,
        }
      : {
          subject: `A new service request from ${p.compoundName}`,
          lead: `A resident of ${p.compoundName} has a new service request for you. Open the desk link the management gave you to see it and answer.`,
        };
  return {
    subject: t.subject,
    text: locale === 'ar' ? rtlText([t.lead]) : t.lead,
    html: emailPage(locale, `<p>${escapeHtml(t.lead)}</p>`),
  };
}

/** Registers the partners' email templates with the core outbox. */
@Injectable()
export class PartnerEmailTemplates implements OnModuleInit {
  constructor(private readonly templates: EmailTemplates) {}

  onModuleInit(): void {
    // To an address that is no account's: no preference applies, and the
    // desk is its record.
    this.templates.register(
      PARTNER_EMAILS.newRequest,
      (locale, p) =>
        renderNewRequestEmail(locale, p as { compoundName: string }),
      { category: 'partners', critical: false, soleRecord: false },
    );
  }
}
