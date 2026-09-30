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
