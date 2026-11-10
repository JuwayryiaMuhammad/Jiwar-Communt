import type { Translation } from '@jiwar/i18n';
import type en from '../en/fin-statements.ts';

const ar: Translation<typeof en> = {
  title: 'كشوف الحساب البنكية',
  description: 'استورد ملف CSV من البنك وطابق بنوده مع الدفعات والشيكات والتحويلات المسجّلة هنا.',
  importTitle: 'الاستيراد',
  bankAccount: 'الحساب البنكي',
  columns: 'الأعمدة: التاريخ (YYYY-MM-DD)، والمبلغ (الداخل موجب)، والمرجع، والوصف. استيراد الملف نفسه مرتين لا يضيف جديدًا.',
  check: 'افحص كشف حساب',
  summary: '{rows, plural, =0 {لا بنود} one {بند واحد} two {بندان} few {# بنود} many {# بندًا} other {# بند}}: {fresh} جديد، و{duplicates} سبق استيراده، و{errors} به خطأ',
  errorLine: 'السطر {line}، {field}: {what}',
  apply: 'طبّق',
  applied: 'تم استيراد {imported, plural, =0 {لا بنود} one {بند واحد} two {بندين} few {# بنود} many {# بندًا} other {# بند}}، وطابق {matched} منها تلقائيًا.',
  lines: 'البنود',
  waiting: 'بانتظار المطابقة',
  matched: 'مطابقة',
  empty: 'لا يوجد',
  day: 'اليوم',
  reference: 'المرجع',
  description2: 'الوصف',
  match: 'المطابقة',
  onItsOwn: '{kind} · تلقائيًا',
  undo: 'تراجع',
  undone: 'تم التراجع.',
  'match.title': 'مطابقة {amount} بتاريخ {day}',
  'match.done': 'تمت المطابقة.',
  'match.to': 'مع',
  'match.hint': 'المبلغ نفسه خلال 30 يومًا، أو تسوية (رسوم بنكية أو فائدة).',
  'match.choose': 'اختر…',
  'match.adjustment': 'تسوية…',
  'match.why': 'السبب',
};

export default ar;
