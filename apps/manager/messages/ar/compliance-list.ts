import type { Translation } from '@jiwar/i18n';
import type en from '../en/compliance-list.ts';

const ar: Translation<typeof en> = {
  title: 'الامتثال',
  description: 'أنظمة الإطفاء والمصاعد والتأمين والتراخيص والتصاريح: من المسؤول عن كل بند، وموعد استحقاقه، وأدلته.',
  exportCsv: 'تصدير CSV',
  newItem: 'بند جديد',
  'stat.valid': 'ساري',
  'stat.dueSoon': 'يستحق قريبًا',
  'stat.overdue': 'متأخر',
  'stat.completed': 'أُنجز مرة واحدة',
  'stat.vendorPapers': 'أوراق موردين منتهية',
  itemsTitle: 'البنود',
  none: 'لا توجد بنود امتثال',
  'col.item': 'البند',
  'col.state': 'الحالة',
  'col.due': 'الاستحقاق',
  'col.answers': 'المسؤول عنه',
  added: 'أُضيف البند إلى التقويم.',
  newTitle: 'بند امتثال جديد',
  add: 'أضف',
  firstDue: 'أول استحقاق',
  titleField: 'العنوان',
  authority: 'الجهة',
  authorityHint: 'الجهة المصدرة.',
  reference: 'المرجع',
  staffMember: 'الموظف',
  staffHint: 'يُنبَّه عند اقتراب الموعد.',
  nobody: 'لا أحد',
  vendor: 'المورد',
  noVendor: 'لا يوجد',
  everyMonths: 'يتكرر كل كم شهرًا',
  everyHint: 'اتركه فارغًا إذا كان مرة واحدة.',
};

export default ar;
