import type { Translation } from '@jiwar/i18n';
import type en from '../en/fin-budget-planning.ts';

const ar: Translation<typeof en> = {
  title: 'تخطيط الميزانية',
  description:
    'انقل مبالغ بين البنود (ما يزيد على حد المدير يُعرض على مجلس الإدارة)، واقرأ السنة بالشهر أو بالربع، وبيّن سبب تجاوز أي بند لخطته. ما تلتزم به العقود والمشتريات المعتمدة يُخصم مما يتاح للبند.',
  moveTitle: 'نقل مبلغ بين بندين',
  chooseLine: 'اختر بندًا',
  lineAvailable: '{category} · المتاح {amount}',
  egp: 'ج.م',
  why: 'السبب',
  move: 'انقل',
  moved: 'تم النقل.',
  aboveLimit: 'المبلغ فوق حد المدير: ارفعه إلى مجلس الإدارة من القائمة.',
  reasonRecorded: 'تم تسجيل السبب.',
  'col.when': 'الموعد',
  'col.lines': 'البنود',
  noTransfer: 'لا توجد تحويلات',
  putToBoard: 'ارفعه إلى المجلس',
  yearTitle: 'السنة حسب الفترة',
  varianceDescription: 'إذا تجاوز البند {pct}% من خطته، تطلب الفترة المغلقة سببًا: {missing} بلا سبب حتى الآن.',
  noVariance: 'لا يوجد حد للانحراف: الأسباب اختيارية.',
  by: 'حسب',
  month: 'الشهر',
  quarter: 'الربع',
  'col.line': 'البند',
  'col.period': 'الفترة',
  'col.planned': 'المخطط',
  'col.actual': 'الفعلي',
  'col.variance': 'الفرق',
  sayWhy: 'اذكر السبب',
  committedTitle: 'المبالغ الملتزم بها',
  committedDescription: 'دفعات العقود غير المسددة في السنة والمشتريات المعتمدة، إلى أن تصدر بها فاتورة.',
  nothingCommitted: 'لا التزامات',
  'col.source': 'المصدر',
  'col.due': 'الاستحقاق',
  'col.keeps': 'المحجوز',
  keeps: '{open} من {amount}',
  explainTitle: 'لماذا تجاوز البند خطته؟',
  record: 'سجّل',
};

export default ar;
