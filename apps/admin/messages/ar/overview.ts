import type { Translation } from '@jiwar/i18n';
import type en from '../en/overview.ts';

const ar: Translation<typeof en> = {
  title: 'نظرة عامة',
  description: 'المجمعات على المنصة، وما جرى خلال آخر 24 ساعة.',
  newCompound: 'مجمع جديد',
  'stat.compounds': 'المجمعات',
  'stat.active':
    '{n, plural, =0 {لا يوجد مجمع نشط} one {مجمع نشط واحد} two {مجمعان نشطان} few {# مجمعات نشطة} many {# مجمعًا نشطًا} other {# مجمع نشط}}',
  'stat.suspended': 'الموقوفة',
  'stat.suspendedHint': 'تسجيل الدخول ممنوع على كل من فيها',
  'stat.events': 'أحداث الأمان · 24 ساعة',
  'stat.eventsHint': 'تسجيلات الدخول والجلسات والرموز',
  'stat.alerts': 'تحتاج إلى مراجعة · 24 ساعة',
  'stat.alertsHint': 'رموز خاطئة، وقفل حسابات، وإعادة استخدام رموز الجلسة',
  'events.title': 'أحدث أحداث الأمان',
  'events.all': 'كل الأحداث',
  'events.compound': 'المجمع {id}',
  'events.platform': 'المنصة',
  'events.noTenant': 'بلا مجمع',
  'events.emptyTitle': 'يوم هادئ',
  'events.empty': 'لا توجد أحداث أمان خلال آخر 24 ساعة.',
  'newest.title': 'أحدث المجمعات',
  'newest.opened': 'فُتح {when}',
  'newest.empty': 'لا توجد مجمعات بعد',
  'actions.title': 'آخر إجراءات المنصة',
  'actions.audit': 'سجل تدقيق المنصة',
  'actions.empty': 'لا توجد إجراءات بعد',
};

export default ar;
