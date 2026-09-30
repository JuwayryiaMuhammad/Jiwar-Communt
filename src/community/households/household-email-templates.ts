import { Injectable, type OnModuleInit } from '@nestjs/common';
import { EmailTemplates } from '../../core/mail/email-templates';
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
} as const;

/** Stored params: dates travel as ISO strings. */
export type StoredDelegationEmail = Omit<DelegationEmail, 'expiresAt'> & {
  expiresAt: string;
};

/** Registers the household's email templates with the core outbox. */
@Injectable()
export class HouseholdEmailTemplates implements OnModuleInit {
  constructor(private readonly templates: EmailTemplates) {}

  onModuleInit(): void {
    this.templates.register(HOUSEHOLD_EMAILS.memberRemoved, (locale, p) =>
      renderMemberRemovedEmail(locale, p as unknown as MembershipEmail),
    );
    this.templates.register(HOUSEHOLD_EMAILS.joinRejected, (locale, p) =>
      renderJoinRejectedEmail(locale, p as unknown as MembershipEmail),
    );
    this.templates.register(HOUSEHOLD_EMAILS.delegation, (locale, p) => {
      const stored = p as unknown as StoredDelegationEmail;
      return renderDelegationEmail(locale, {
        ...stored,
        expiresAt: new Date(stored.expiresAt),
      });
    });
  }
}
