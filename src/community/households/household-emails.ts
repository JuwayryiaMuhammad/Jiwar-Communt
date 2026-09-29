import type { Locale } from '../../core/common/i18n/locale';
import {
  emailPage,
  escapeHtml,
  rtlText,
  type RenderedEmail,
} from '../../core/mail/layout';

export interface MembershipEndedEmail {
  /** removed by the household, or a join request declined by management */
  kind: 'removed' | 'rejected';
  compoundName: string;
  unitCode: string;
  reason: string;
}

/**
 * "Never silent" (ADR 0016): the person always learns that they left a
 * household, and why, in their own language.
 */
export function renderMembershipEndedEmail(
  locale: Locale,
  e: MembershipEndedEmail,
): RenderedEmail {
  const t = locale === 'ar' ? arabic(e) : english(e);
  const lines = [t.lead, '', `${t.reasonLabel}: ${e.reason}`, '', t.help];
  return {
    subject: t.subject,
    text: locale === 'ar' ? rtlText(lines) : lines.join('\n'),
    html: emailPage(
      locale,
      `<p>${escapeHtml(t.lead)}</p><p><strong>${t.reasonLabel}:</strong> ${escapeHtml(e.reason)}</p><p style="color:#666">${t.help}</p>`,
    ),
  };
}

function english(e: MembershipEndedEmail) {
  return e.kind === 'removed'
    ? {
        subject: 'You were removed from a household on Jiwar',
        lead: `You are no longer a member of the household of unit ${e.unitCode} in ${e.compoundName}.`,
        reasonLabel: 'Reason',
        help: "If you think this is a mistake, contact the unit's primary resident or the compound management.",
      }
    : {
        subject: 'Your household request on Jiwar was declined',
        lead: `The compound management declined your request to join the household of unit ${e.unitCode} in ${e.compoundName}.`,
        reasonLabel: 'Reason',
        help: 'If you think this is a mistake, contact the compound management.',
      };
}

function arabic(e: MembershipEndedEmail) {
  return e.kind === 'removed'
    ? {
        subject: 'تمت إزالتك من أسرة وحدة على جوار',
        lead: `لم تعد فردًا في أسرة الوحدة ${e.unitCode} في ${e.compoundName}.`,
        reasonLabel: 'السبب',
        help: 'إذا كنت تعتقد أن هذا خطأ، تواصل مع الساكن الرئيسي للوحدة أو مع إدارة المجمع.',
      }
    : {
        subject: 'تم رفض طلب انضمامك إلى أسرة على جوار',
        lead: `رفضت إدارة المجمع طلب انضمامك إلى أسرة الوحدة ${e.unitCode} في ${e.compoundName}.`,
        reasonLabel: 'السبب',
        help: 'إذا كنت تعتقد أن هذا خطأ، تواصل مع إدارة المجمع.',
      };
}
