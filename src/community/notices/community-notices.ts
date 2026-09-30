import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Locale } from '../../core/common/i18n/locale';
import { EmailTemplates } from '../../core/mail/email-templates';
import {
  emailPage,
  escapeHtml,
  rtlText,
  type RenderedEmail,
} from '../../core/mail/layout';

/**
 * Phase 2.2 community notices (ADR 0019 outbox). Every one is plain: a
 * subject, one lead line, an optional reason the person is told, and where
 * to turn. Params are strings, stored with the message and rendered at send
 * time; nothing here is ever written to the audit trail.
 */
export const COMMUNITY_NOTICES = {
  occupancyEnded: 'community.occupancy_ended',
  capacityChanged: 'community.capacity_changed',
  handedOver: 'community.handed_over',
  primaryChanged: 'community.primary_changed',
  unitUnderReview: 'community.unit_under_review',
  activityPaused: 'community.activity_paused',
  permissionRevoked: 'community.permission_revoked',
  deferredActionSubmitted: 'community.deferred_action_submitted',
  deferredActionDeclined: 'community.deferred_action_declined',
  majorityReached: 'community.majority_reached',
  cameOfAge: 'community.came_of_age',
  workerCodeReissued: 'community.worker_code_reissued',
  cardConfiscated: 'community.card_confiscated',
  complianceCaseOpened: 'community.compliance_case_opened',
  memberFrozen: 'community.member_frozen',
  registrationApproved: 'community.registration_approved',
  registrationRejected: 'community.registration_rejected',
  registrationExpired: 'community.registration_expired',
} as const;

export type CommunityNoticeKey =
  (typeof COMMUNITY_NOTICES)[keyof typeof COMMUNITY_NOTICES];

/** `compoundName` and `unitCode` always; the rest per notice. */
export type NoticeParams = Record<string, string> & {
  compoundName: string;
  unitCode?: string;
  /** What the person is told as the reason, verbatim. */
  reason?: string;
};

interface Texts {
  subject: string;
  lead: string;
  help?: string;
}

type Catalog = Record<
  CommunityNoticeKey,
  Record<Locale, (p: NoticeParams) => Texts>
>;

const CAPACITY = {
  ar: {
    owner_resident: 'مالك مقيم',
    owner_landlord: 'مالك مؤجِّر',
    tenant: 'مستأجر',
  },
  en: {
    owner_resident: 'resident owner',
    owner_landlord: 'owner (not living in the unit)',
    tenant: 'tenant',
  },
} as const;

const PERMISSION = {
  ar: {
    visitors_invite: 'دعوة الزوار',
    bookings: 'الحجوزات',
    tickets: 'البلاغات',
    finance: 'العمليات المالية',
    unit_security: 'أجهزة حماية الوحدة',
  },
  en: {
    visitors_invite: 'inviting visitors',
    bookings: 'bookings',
    tickets: 'maintenance tickets',
    finance: 'payments',
    unit_security: 'unit security devices',
  },
} as const;

/** A comma-separated list of permission keys, in words. */
function permissions(locale: Locale, value: string | undefined): string {
  const names = PERMISSION[locale] as Record<string, string>;
  return (value ?? '')
    .split(',')
    .filter(Boolean)
    .map((k) => names[k] ?? k)
    .join(locale === 'ar' ? '، ' : ', ');
}

function capacity(locale: Locale, value: string | undefined): string {
  const names = CAPACITY[locale] as Record<string, string>;
  return (value && names[value]) ?? value ?? '';
}

const CATALOG: Catalog = {
  'community.occupancy_ended': {
    ar: (p) => ({
      subject: 'انتهى إشغالك لوحدة على جوار',
      lead: `انتهى إشغالك للوحدة ${p.unitCode} في ${p.compoundName}. يمكنك عرض سجلك فقط.`,
      help: 'إذا كنت تعتقد أن هذا خطأ، تواصل مع إدارة المجمع.',
    }),
    en: (p) => ({
      subject: 'Your occupancy of a unit on Jiwar has ended',
      lead: `Your occupancy of unit ${p.unitCode} in ${p.compoundName} has ended. You can still view your records.`,
      help: 'If you think this is a mistake, contact the compound management.',
    }),
  },
  'community.capacity_changed': {
    ar: (p) => ({
      subject: 'تغيّرت صفتك في وحدة على جوار',
      lead: `تغيّرت صفتك في الوحدة ${p.unitCode} في ${p.compoundName} إلى: ${capacity('ar', p.capacity)}.`,
      help: 'تتغير الخدمات المتاحة لك في التطبيق بحسب صفتك الجديدة.',
    }),
    en: (p) => ({
      subject: 'Your capacity in a unit on Jiwar changed',
      lead: `Your capacity in unit ${p.unitCode} in ${p.compoundName} is now: ${capacity('en', p.capacity)}.`,
      help: 'What you can do in the app follows your new capacity.',
    }),
  },
  'community.handed_over': {
    ar: (p) => ({
      subject: 'تم تسجيل تسليم وحدة على جوار',
      lead: `سجّلت الإدارة تسليمك للوحدة ${p.unitCode} في ${p.compoundName}. لم يعد زر الطوارئ لهذه الوحدة ظاهراً لك.`,
    }),
    en: (p) => ({
      subject: 'Your handover of a unit on Jiwar was recorded',
      lead: `The management recorded that you handed over unit ${p.unitCode} in ${p.compoundName}. Its emergency button is no longer shown to you.`,
    }),
  },
  'community.primary_changed': {
    ar: (p) => ({
      subject: 'ساكن رئيسي جديد لوحدتك على جوار',
      lead: `أصبح ${p.primaryName} الساكن الرئيسي للوحدة ${p.unitCode} في ${p.compoundName}. تبقى صلاحياتك كما هي حتى يراجعها.`,
    }),
    en: (p) => ({
      subject: 'Your unit on Jiwar has a new primary resident',
      lead: `${p.primaryName} is now the primary resident of unit ${p.unitCode} in ${p.compoundName}. Your permissions stay as they are until they review them.`,
    }),
  },
  // Deliberately says nothing about why (05 §7: the reason is never shown).
  'community.unit_under_review': {
    ar: (p) => ({
      subject: 'شؤون وحدتك قيد المراجعة على جوار',
      lead: `شؤون الوحدة ${p.unitCode} في ${p.compoundName} قيد المراجعة مع الإدارة. تستمر البلاغات والزوار والطوارئ، وتتوقف الإجراءات المالية ومنح الصلاحيات وسحبها مؤقتاً.`,
      help: 'للاستفسار تواصل مع إدارة المجمع.',
    }),
    en: (p) => ({
      subject: 'Your unit on Jiwar is under review',
      lead: `The affairs of unit ${p.unitCode} in ${p.compoundName} are under review with the management. Tickets, visitors and emergency continue; payments and permission changes are paused for now.`,
      help: 'For questions, contact the compound management.',
    }),
  },
  'community.activity_paused': {
    ar: (p) => ({
      subject: 'أُوقف عرض النشاط في وحدتك على جوار',
      lead: `أُوقف عرض النشاط أثناء المراجعة في الوحدة ${p.unitCode} في ${p.compoundName}. تبقى لك الطوارئ والدخول والبلاغات والتواصل مع الإدارة، ويصلك إشعار الزائر كما كان.`,
    }),
    en: (p) => ({
      subject: 'Activity view paused in your unit on Jiwar',
      lead: `The activity view is paused during a review in unit ${p.unitCode} in ${p.compoundName}. Emergency, entry, tickets and contacting the management stay, and visitor notices still reach you.`,
    }),
  },
  'community.permission_revoked': {
    ar: (p) => ({
      subject: 'سُحبت صلاحية على جوار',
      lead: `سُحبت صلاحية ${permissions('ar', p.permissions)} في الوحدة ${p.unitCode} في ${p.compoundName}. تبقى لك دائماً الطوارئ ودليل التصرف والتواصل مع الساكن الرئيسي.`,
      help: 'لطلب توضيح، تواصل مع الساكن الرئيسي للوحدة.',
    }),
    en: (p) => ({
      subject: 'A permission was withdrawn on Jiwar',
      lead: `Your permission for ${permissions('en', p.permissions)} in unit ${p.unitCode} in ${p.compoundName} was withdrawn. Emergency, the conduct guide and contacting the primary resident always stay.`,
      help: "To ask why, contact the unit's primary resident.",
    }),
  },
  'community.deferred_action_submitted': {
    ar: (p) => ({
      subject: 'طلب من أحد أفراد أسرتك على جوار',
      lead: `أرسل ${p.memberName} إجراءً يحتاج صلاحية ${permissions('ar', p.permission)} في الوحدة ${p.unitCode} في ${p.compoundName}، وهو بانتظار قرارك.`,
    }),
    en: (p) => ({
      subject: 'A request from your household on Jiwar',
      lead: `${p.memberName} sent an action that needs ${permissions('en', p.permission)} in unit ${p.unitCode} in ${p.compoundName}. It is waiting for your decision.`,
    }),
  },
  'community.deferred_action_declined': {
    ar: (p) => ({
      subject: 'لم تتم الموافقة على طلبك على جوار',
      lead: `لم يوافق الساكن الرئيسي على طلبك الخاص بـ${permissions('ar', p.permission)} في الوحدة ${p.unitCode} في ${p.compoundName}.`,
    }),
    en: (p) => ({
      subject: 'Your request on Jiwar was not approved',
      lead: `The primary resident did not approve your request for ${permissions('en', p.permission)} in unit ${p.unitCode} in ${p.compoundName}.`,
    }),
  },
  'community.majority_reached': {
    ar: (p) => ({
      subject: 'أحد أفراد أسرتك بلغ سن الرشد على جوار',
      lead: `بلغ ${p.memberName} سن الرشد في الوحدة ${p.unitCode} في ${p.compoundName}. لا يُرفع الوضع المقيّد تلقائياً: ادعه لحساب خاص به لتأكيد ذلك.`,
    }),
    en: (p) => ({
      subject: 'A member of your household came of age on Jiwar',
      lead: `${p.memberName} is now 18 in unit ${p.unitCode} in ${p.compoundName}. Minor status is never lifted automatically: invite them to their own account to confirm.`,
    }),
  },
  'community.came_of_age': {
    ar: (p) => ({
      subject: 'أصبح لك حساب على جوار',
      lead: `رُفع الوضع المقيّد وأصبح لك حساب في الوحدة ${p.unitCode} في ${p.compoundName}: دعوة الزوار والحجوزات والبلاغات متاحة لك الآن، ويبقى سجلك كاملاً.`,
    }),
    en: (p) => ({
      subject: 'You now have your own Jiwar account',
      lead: `Your minor status was lifted and you now have an account in unit ${p.unitCode} in ${p.compoundName}: inviting visitors, bookings and tickets are available to you, and your history stays yours.`,
    }),
  },
  // Never the reason: a confiscation must not reach the resident (11 §7).
  'community.worker_code_reissued': {
    ar: (p) => ({
      subject: 'صدر كود جديد لعامل على جوار',
      lead: `صدر كود دخول جديد لـ${p.workerName} في الوحدة ${p.unitCode} في ${p.compoundName}، وأُلغي الكود السابق. ستُسلَّم البطاقة الجديدة للعامل بلا رسوم.`,
    }),
    en: (p) => ({
      subject: 'A new worker code was issued on Jiwar',
      lead: `A new entry code was issued to ${p.workerName} for unit ${p.unitCode} in ${p.compoundName}, and the previous one no longer works. The worker receives the new card free of charge.`,
    }),
  },
  'community.card_confiscated': {
    ar: (p) => ({
      subject: 'بلاغ مصادرة بطاقة عامل على جوار',
      lead: `سُجّل بلاغ مصادرة بطاقة عامل للوحدة ${p.unitCode} في ${p.compoundName} (ملف ${p.incidentId}). أُصدر كود بديل وفُتح ملف مراجعة.`,
      help: 'لا يُبلَّغ ساكن الوحدة بسبب إعادة الإصدار.',
    }),
    en: (p) => ({
      subject: "A worker's card was reported confiscated on Jiwar",
      lead: `A worker's card for unit ${p.unitCode} in ${p.compoundName} was reported confiscated (file ${p.incidentId}). A replacement code was issued and a review file opened.`,
      help: "The unit's resident is not told why the code was reissued.",
    }),
  },
  'community.compliance_case_opened': {
    ar: (p) => ({
      subject: 'ملف امتثال جديد على جوار',
      lead: `فُتح ملف امتثال في ${p.compoundName} (ملف ${p.caseId}): عامل تبيّن أنه دون السن القانونية. أُوقفت أكواده، ويُصرف أجره كاملاً عن أيام عمله.`,
    }),
    en: (p) => ({
      subject: 'A new compliance case on Jiwar',
      lead: `A compliance case was opened in ${p.compoundName} (case ${p.caseId}): a worker was found to be under 18. Their codes are stopped, and their wage is owed in full for the days worked.`,
    }),
  },
  'community.member_frozen': {
    ar: (p) => ({
      subject: 'أُوقف حساب أحد أفراد أسرتك على جوار',
      lead: `أوقفت الإدارة حساب أحد أفراد أسرة الوحدة ${p.unitCode} في ${p.compoundName} لأن رقم هاتفه انتقل لشخص آخر. ستتواصل الإدارة معه لتسجيل رقم جديد.`,
    }),
    en: (p) => ({
      subject: "A household member's Jiwar account was frozen",
      lead: `The management froze the account of a member of unit ${p.unitCode}'s household in ${p.compoundName}: their phone number now belongs to someone else. The management will contact them to register a new number.`,
    }),
  },
  'community.registration_approved': {
    ar: (p) => ({
      subject: 'اعتُمد تسجيلك على جوار',
      lead: `اعتمدت إدارة ${p.compoundName} تسجيلك في الوحدة ${p.unitCode}. يمكنك الدخول الآن ببريدك أو رقم هاتفك.`,
    }),
    en: (p) => ({
      subject: 'Your Jiwar registration was approved',
      lead: `The management of ${p.compoundName} approved your registration for unit ${p.unitCode}. You can log in now with your email or phone number.`,
    }),
  },
  // Says the manager's reason only — never what the review showed.
  'community.registration_rejected': {
    ar: (p) => ({
      subject: 'لم يُعتمد طلب تسجيلك على جوار',
      lead: `لم تعتمد إدارة ${p.compoundName} طلب تسجيلك في الوحدة ${p.unitCode}.`,
      help: 'للاستفسار تواصل مع إدارة المجمع.',
    }),
    en: (p) => ({
      subject: 'Your Jiwar registration was not approved',
      lead: `The management of ${p.compoundName} did not approve your registration request for unit ${p.unitCode}.`,
      help: 'For questions, contact the compound management.',
    }),
  },
  'community.registration_expired': {
    ar: (p) => ({
      subject: 'انتهت مهلة طلب تسجيلك على جوار',
      lead: `انتهت مهلة طلب تسجيلك في الوحدة ${p.unitCode} في ${p.compoundName} دون قرار، وحُذفت بياناتك منه. يمكنك التسجيل من جديد أو التواصل مع الإدارة.`,
    }),
    en: (p) => ({
      subject: 'Your Jiwar registration request expired',
      lead: `Your registration request for unit ${p.unitCode} in ${p.compoundName} expired without a decision, and your details were removed from it. You can register again or contact the management.`,
    }),
  },
};

export function renderCommunityNotice(
  key: CommunityNoticeKey,
  locale: Locale,
  p: NoticeParams,
): RenderedEmail {
  const t = CATALOG[key][locale](p);
  const reasonLabel = locale === 'ar' ? 'السبب' : 'Reason';
  const lines = [
    t.lead,
    ...(p.reason ? ['', `${reasonLabel}: ${p.reason}`] : []),
    ...(t.help ? ['', t.help] : []),
  ];
  const html = [
    `<p>${escapeHtml(t.lead)}</p>`,
    p.reason
      ? `<p><strong>${reasonLabel}:</strong> ${escapeHtml(p.reason)}</p>`
      : '',
    t.help ? `<p style="color:#666">${escapeHtml(t.help)}</p>` : '',
  ].join('');
  return {
    subject: t.subject,
    text: locale === 'ar' ? rtlText(lines) : lines.join('\n'),
    html: emailPage(locale, html),
  };
}

/** Registers every Phase 2.2 community notice with the core outbox. */
@Injectable()
export class CommunityNoticeTemplates implements OnModuleInit {
  constructor(private readonly templates: EmailTemplates) {}

  onModuleInit(): void {
    for (const key of Object.values(COMMUNITY_NOTICES)) {
      this.templates.register(key, (locale, p) =>
        renderCommunityNotice(key, locale, p as NoticeParams),
      );
    }
  }
}
