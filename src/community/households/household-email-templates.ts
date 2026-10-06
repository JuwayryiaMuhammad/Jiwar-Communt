import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Locale } from '../../core/common/i18n/locale';
import {
  EmailTemplates,
  type EmailDelivery,
} from '../../core/mail/email-templates';
import {
  emailPage,
  escapeHtml,
  rtlText,
  type RenderedEmail,
} from '../../core/mail/layout';
import {
  renderDelegationEmail,
  renderJoinRejectedEmail,
  renderMemberRemovedEmail,
  type DelegationEmail,
  type MembershipEmail,
} from './household-emails';

/** Outbox template keys of the household (ADR 0019). */
export const HOUSEHOLD_EMAILS = {
  memberRemoved: 'household.member_removed',
  joinRejected: 'household.join_rejected',
  delegation: 'household.delegation',
  /** A family member's account was deleted (ADR 0036), to the primary. */
  memberAccountDeleted: 'household.member_account_deleted',
} as const;

/** Stored params: dates travel as ISO strings. */
export type StoredDelegationEmail = Omit<DelegationEmail, 'expiresAt'> & {
  expiresAt: string;
};

/**
 * Household notices have no inbox twin: the email is their only record, so
 * a household switched off never skips them (ADR 0036, ADR 0016).
 */
const DELIVERY: EmailDelivery = {
  category: 'household',
  critical: false,
  soleRecord: true,
};

/** A member's account was deleted: the unit's code, never a name or reason. */
export function renderMemberAccountDeletedEmail(
  locale: Locale,
  p: { compoundName: string; unitCode: string },
): RenderedEmail {
  const t =
    locale === 'ar'
      ? {
          subject: 'حُذف حساب أحد أفراد أسرتك على جوار',
          lead: `حُذف حساب أحد أفراد أسرة الوحدة ${p.unitCode} في ${p.compoundName}، ولم يعد من أفرادها.`,
        }
      : {
          subject: 'A household member’s Jiwar account was deleted',
          lead: `The account of a member of unit ${p.unitCode}'s household in ${p.compoundName} was deleted; they are no longer a member.`,
        };
  return {
    subject: t.subject,
    text: locale === 'ar' ? rtlText([t.lead]) : t.lead,
    html: emailPage(locale, `<p>${escapeHtml(t.lead)}</p>`),
  };
}

/** Registers the household's email templates with the core outbox. */
@Injectable()
export class HouseholdEmailTemplates implements OnModuleInit {
  constructor(private readonly templates: EmailTemplates) {}

  onModuleInit(): void {
    this.templates.register(
      HOUSEHOLD_EMAILS.memberRemoved,
      (locale, p) =>
        renderMemberRemovedEmail(locale, p as unknown as MembershipEmail),
      DELIVERY,
    );
    this.templates.register(
      HOUSEHOLD_EMAILS.joinRejected,
      (locale, p) =>
        renderJoinRejectedEmail(locale, p as unknown as MembershipEmail),
      DELIVERY,
    );
    this.templates.register(
      HOUSEHOLD_EMAILS.delegation,
      (locale, p) => {
        const stored = p as unknown as StoredDelegationEmail;
        return renderDelegationEmail(locale, {
          ...stored,
          expiresAt: new Date(stored.expiresAt),
        });
      },
      DELIVERY,
    );
    // It has an inbox twin (`household.member_account_deleted`).
    this.templates.register(
      HOUSEHOLD_EMAILS.memberAccountDeleted,
      (locale, p) =>
        renderMemberAccountDeletedEmail(
          locale,
          p as { compoundName: string; unitCode: string },
        ),
      { category: 'household', critical: false, soleRecord: false },
    );
  }
}
