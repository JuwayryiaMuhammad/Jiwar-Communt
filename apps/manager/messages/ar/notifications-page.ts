import type { Translation } from '@jiwar/i18n';
import type en from '../en/notifications-page.ts';

const ar: Translation<typeof en> = {
  title: 'الإشعارات',
  description:
    'ما أخبرك به المجمع. إعدادات الإشعارات تحدد ما يُرسل أيضًا بالبريد الإلكتروني، ولا تحدد أبدًا ما يظهر هنا.',
  settings: 'الإعدادات',
  markAllRead: 'اعتبرها كلها مقروءة',
  which: 'أي الإشعارات',
  unread: 'غير مقروءة',
  unreadCount: 'غير مقروءة ({count})',
  all: 'الكل',
  urgent: 'عاجل',
  readSuffix: ' · مقروء',
  markRead: 'اعتبره مقروءًا',
  markedRead:
    '{n, plural, =0 {لا إشعارات اعتُبرت مقروءة.} one {اعتُبر إشعار واحد مقروءًا.} two {اعتُبر إشعاران مقروءين.} few {اعتُبرت # إشعارات مقروءة.} many {اعتُبر # إشعارًا مقروءًا.} other {اعتُبر # إشعار مقروءًا.}}',
  nothingUnread: 'لا يوجد إشعار غير مقروء',
  noNotifications: 'لا توجد إشعارات',
  allRead: 'قرأت كل شيء. الإشعارات الأقدم تجدها في «الكل».',
  emptyAll: 'تظهر هنا حالات الطوارئ، وبلاغات الصيانة التي تحتاج موزّعًا، والطرود المحتجزة طويلًا، وطلبات الحذف.',
  actionsTitle: 'إجراءاتي التصحيحية',
  actionsDescription: 'ما طلبه منك التحقيق في حادثة، مرتبًا بيوم استحقاقه.',
  actionsEmpty: 'لا يوجد شيء مطلوب منك',
  markedDone: 'تم تسجيله منجزًا.',
  incident: 'الحادثة',
  action: 'الإجراء',
  due: 'الاستحقاق',
  dueOverdue: '{date} · متأخر',
  done: 'تم',
};

export default ar;
