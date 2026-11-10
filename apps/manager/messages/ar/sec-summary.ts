import type { Translation } from '@jiwar/i18n';
import type en from '../en/sec-summary.ts';

const ar: Translation<typeof en> = {
  title: 'الحوادث والمخالفات',
  description: 'أعداد فقط، دون أي اسم أو وحدة، ولمدة 31 يومًا كحد أقصى. ويحسب التقرير اليومي أعداد كل موقع أيضًا.',
  exportCsv: 'تصدير CSV',
  incidentsTitle: 'الحوادث حسب وقت وقوعها',
  violationsTitle: 'المخالفات حسب يومها',
  allTypes: 'كل الأنواع',
  allKinds: 'كل الأنواع',
  emptyIncidents: 'لا توجد حوادث',
  emptyViolations: 'لا توجد مخالفات',
  'inc.type': 'النوع',
  'inc.reported': 'المبلَّغ عنها',
  'inc.byGuards': 'من الحراس',
  'inc.low': 'منخفضة',
  'inc.medium': 'متوسطة',
  'inc.high': 'عالية',
  'inc.critical': 'حرجة',
  'inc.open': 'مفتوحة',
  'inc.investigating': 'قيد التحقيق',
  'inc.closed': 'مغلقة',
  'inc.hours': 'ساعات حتى الإغلاق',
  'vio.kind': 'النوع',
  'vio.issued': 'الصادرة',
  'vio.byGuards': 'من الحراس',
  'vio.warnings': 'التحذيرات',
  'vio.amountIssued': 'قيمة الغرامات الصادرة',
  'vio.open': 'مفتوحة',
  'vio.underAppeal': 'قيد التظلم',
  'vio.paid': 'مدفوعة',
  'vio.amountPaid': 'المبلغ المدفوع',
  'vio.cancelled': 'ملغاة',
  'vio.appeals': 'تظلمات مرفوضة / مقبولة',
};

export default ar;
