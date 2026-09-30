import type { Locale } from '../../core/common/i18n/locale';
import {
  emailPage,
  escapeHtml,
  rtlText,
  type RenderedEmail,
} from '../../core/mail/layout';

/** Where a membership was, and the reason given (shown to the person). */
export interface MembershipEmail {
  compoundName: string;
  unitCode: string;
  reason: string;
}

/**
 * "Never silent" (ADR 0016): a member removed by the household learns it,
 * and why, in their own language.
 */
export function renderMemberRemovedEmail(
  locale: Locale,
  e: MembershipEmail,
): RenderedEmail {
  return render(
    locale,
    e,
    locale === 'ar'
      ? {
          subject: 'تمت إزالتك من أسرة وحدة على جوار',
          lead: `لم تعد فردًا في أسرة الوحدة ${e.unitCode} في ${e.compoundName}.`,
          reasonLabel: 'السبب',
          help: 'إذا كنت تعتقد أن هذا خطأ، تواصل مع الساكن الرئيسي للوحدة أو مع إدارة المجمع.',
        }
      : {
          subject: 'You were removed from a household on Jiwar',
          lead: `You are no longer a member of the household of unit ${e.unitCode} in ${e.compoundName}.`,
          reasonLabel: 'Reason',
          help: "If you think this is a mistake, contact the unit's primary resident or the compound management.",
        },
  );
}

/**
 * A join request that management did not approve (ADR 0016). Its own
 * message: the person was never a member, so "removed" would be wrong.
 */
export function renderJoinRejectedEmail(
  locale: Locale,
  e: MembershipEmail,
): RenderedEmail {
  return render(
    locale,
    e,
    locale === 'ar'
      ? {
          subject: 'لم تتم الموافقة على طلب انضمامك إلى أسرة على جوار',
          lead: `لم توافق إدارة المجمع على طلب انضمامك إلى أسرة الوحدة ${e.unitCode} في ${e.compoundName}.`,
          reasonLabel: 'السبب',
          help: 'إذا كنت تعتقد أن هذا خطأ، تواصل مع إدارة المجمع أو مع من دعاك.',
        }
      : {
          subject: 'Your request to join a household on Jiwar was not approved',
          lead: `The compound management did not approve your request to join the household of unit ${e.unitCode} in ${e.compoundName}.`,
          reasonLabel: 'Reason',
          help: 'If you think this is a mistake, contact the compound management or the person who invited you.',
        },
  );
}

function render(
  locale: Locale,
  e: MembershipEmail,
  t: { subject: string; lead: string; reasonLabel: string; help: string },
): RenderedEmail {
  const lines = [t.lead, '', `${t.reasonLabel}: ${e.reason}`, '', t.help];
  return {
    subject: t.subject,
    text: locale === 'ar' ? rtlText(lines) : lines.join('\n'),
    html: emailPage(
      locale,
      `<p>${escapeHtml(t.lead)}</p><p><strong>${t.reasonLabel}:</strong> ${escapeHtml(e.reason)}</p><p style="color:#666">${escapeHtml(t.help)}</p>`,
    ),
  };
}

// ---------------------------------------------------------------------------
// Delegation (ADR 0016): both sides are told on create, revoke and end.
// ---------------------------------------------------------------------------

export type DelegationEvent =
  | { kind: 'created' }
  | { kind: 'revoked' }
  | {
      kind: 'ended';
      reason:
        | 'expired'
        | 'member_removed'
        | 'primary_changed'
        | 'account_deactivated';
    };

export interface DelegationEmail {
  event: DelegationEvent;
  compoundName: string;
  unitCode: string;
  delegatorName: string;
  delegateName: string;
  scopes: ('household' | 'workers')[];
  expiresAt: Date;
}

const SCOPES = {
  en: {
    household: 'manage the household (invite, add children, remove members)',
    workers: 'manage domestic workers',
  },
  ar: {
    household: 'إدارة أفراد الأسرة (الدعوة، وإضافة الأطفال، والإزالة)',
    workers: 'إدارة العمالة المنزلية',
  },
} as const;

const ENDED = {
  en: {
    expired: 'it reached its end date',
    member_removed: 'the member left the household',
    primary_changed: "the unit's primary resident changed",
    account_deactivated: 'an account was deactivated',
  },
  ar: {
    expired: 'انتهت مدته',
    member_removed: 'لم يعد الفرد ضمن أسرة الوحدة',
    primary_changed: 'تغيّر الساكن الرئيسي للوحدة',
    account_deactivated: 'تم إيقاف أحد الحسابين',
  },
} as const;

export function renderDelegationEmail(
  locale: Locale,
  e: DelegationEmail,
): RenderedEmail {
  const date = e.expiresAt.toISOString().slice(0, 10);
  const scopes = e.scopes.map((s) => SCOPES[locale][s]);
  let subject: string;
  let lead: string;
  let detail: string;
  if (locale === 'ar') {
    const what = scopes.join('، و');
    subject = {
      created: 'تفويض جديد على جوار',
      revoked: 'تم إلغاء تفويض على جوار',
      ended: 'انتهى تفويض على جوار',
    }[e.event.kind];
    lead = {
      created: `فوّض ${e.delegatorName} ${e.delegateName} في ${what} للوحدة ${e.unitCode} في ${e.compoundName}، حتى ${date}.`,
      revoked: `ألغى ${e.delegatorName} تفويض ${e.delegateName} للوحدة ${e.unitCode} في ${e.compoundName}.`,
      ended: `انتهى تفويض ${e.delegateName} للوحدة ${e.unitCode} في ${e.compoundName}.`,
    }[e.event.kind];
    detail =
      e.event.kind === 'ended'
        ? `السبب: ${ENDED.ar[e.event.reason]}.`
        : 'لا يشمل التفويض أي أمور مالية أو عقود أو تصويت أو ملكية.';
  } else {
    const what = scopes.join(' and ');
    subject = {
      created: 'New delegation on Jiwar',
      revoked: 'A delegation on Jiwar was revoked',
      ended: 'A delegation on Jiwar has ended',
    }[e.event.kind];
    lead = {
      created: `${e.delegatorName} authorized ${e.delegateName} to ${what} for unit ${e.unitCode} in ${e.compoundName}, until ${date}.`,
      revoked: `${e.delegatorName} revoked ${e.delegateName}'s delegation for unit ${e.unitCode} in ${e.compoundName}.`,
      ended: `${e.delegateName}'s delegation for unit ${e.unitCode} in ${e.compoundName} has ended.`,
    }[e.event.kind];
    detail =
      e.event.kind === 'ended'
        ? `Reason: ${ENDED.en[e.event.reason]}.`
        : 'A delegation never covers money, contracts, voting or ownership.';
  }
  const lines = [lead, '', detail];
  return {
    subject,
    text: locale === 'ar' ? rtlText(lines) : lines.join('\n'),
    html: emailPage(
      locale,
      `<p>${escapeHtml(lead)}</p><p style="color:#666">${escapeHtml(detail)}</p>`,
    ),
  };
}
