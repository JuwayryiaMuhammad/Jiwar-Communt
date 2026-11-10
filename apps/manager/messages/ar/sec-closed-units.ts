import type { Translation } from '@jiwar/i18n';
import type en from '../en/sec-closed-units.ts';

const ar: Translation<typeof en> = {
  title: 'الوحدات المغلقة',
  description: 'وحدات أغلقها ملّاكها، والأقدم إغلاقًا أولًا. تحين جولة كل بضعة أيام، فجدولها كمعاينة.',
  empty: 'لا توجد وحدة مغلقة',
  emptyHint: 'يغلق المالك وحدته من التطبيق أثناء سفره.',
  'col.unit': 'الوحدة',
  'col.since': 'مغلقة منذ',
  'col.last': 'آخر معاينة',
  'col.request': 'طلب المالك',
  'col.proxies': 'الوكلاء',
  'col.round': 'الجولة',
  noneYet: 'لا شيء حتى الآن',
  requestStatus: '{reference} (الحالة: {status})',
  dueSince: 'مستحقة منذ {date}',
  scheduled: 'مجدولة',
  next: 'التالية {date}',
  schedule: 'جدولة',
  emergencyEntry: 'دخول طارئ',
};

export default ar;
