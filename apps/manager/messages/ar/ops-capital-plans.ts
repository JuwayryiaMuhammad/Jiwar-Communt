import type { Translation } from '@jiwar/i18n';
import type en from '../en/ops-capital-plans.ts';

const ar: Translation<typeof en> = {
  title: 'الخطط الرأسمالية',
  description: 'الاستبدالات والأعمال المخططة لعام واحد، يعتمدها مجلس الإدارة مرة واحدة.',
  year: 'السنة',
  seed: 'ابدأ من الاستبدالات المستحقة في تلك السنة',
  draw: 'أعدّ الخطة',
  empty: 'لا توجد خطة رأسمالية بعد',
  'col.year': 'السنة',
  'col.lines': 'البنود',
  'col.total': 'الإجمالي',
  'col.status': 'الحالة',
  'status.draft': 'مسودة',
  'status.submitted': 'لدى مجلس الإدارة',
  'status.approved': 'معتمدة (مقفلة)',
  planTitle: 'خطة رأسمالية',
  planYear: 'الخطة الرأسمالية لعام {year}',
  planSummary:
    '{n, plural, =0 {لا بنود} one {بند واحد} two {بندان} few {# بنود} many {# بندًا} other {# بند}}، بإجمالي {total}.',
  boardRequest: 'طلب مجلس الإدارة',
  submit: 'قدّمها لمجلس الإدارة',
  what: 'البند',
  amount: 'المبلغ (ج.م)',
  addLine: 'أضف بندًا',
  noLine: 'لا توجد بنود بعد',
  'col.asset': 'الأصل',
  'col.type': 'النوع',
  'col.what': 'البند',
  'col.amount': 'المبلغ',
  'col.source': 'المصدر',
  'source.computed': 'سجل الأصول',
  'source.added': 'مضاف يدويًا',
  remove: 'احذف',
};

export default ar;
