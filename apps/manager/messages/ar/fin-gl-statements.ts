import type { Translation } from '@jiwar/i18n';
import type en from '../en/fin-gl-statements.ts';

const ar: Translation<typeof en> = {
  title: 'القوائم المالية',
  description: 'من دفتر الأستاذ العام: كل رقم هو مجموع قيوده المرحَّلة.',
  from: 'من',
  to: 'إلى',
  asOf: 'حتى تاريخ',
  workbook: 'ملف Excel',
  journalCsv: 'اليومية CSV',
  statement: 'القائمة',
  trial: 'ميزان المراجعة',
  income: 'قائمة الدخل',
  balance: 'الميزانية العمومية',
  empty: 'لا شيء هنا',
  account: 'الحساب',
  total: 'الإجمالي {amount}',
  trialOn: 'ميزان المراجعة في {day}',
  trialTotals: 'المدين {debit}، والدائن {credit}.',
  debit: 'مدين',
  credit: 'دائن',
  balanced: 'متوازن',
  outOfBalance: 'غير متوازن',
  revenue: 'الإيرادات',
  expenses: 'المصروفات',
  surplus: 'الفائض',
  deficit: 'العجز',
  assets: 'الأصول',
  liabilities: 'الخصوم',
  equity: 'حقوق الملكية',
  currentYearResult: 'نتيجة السنة المالية الحالية (من {day}) منفصلة عن الفائض المرحّل:',
  priorYearsResult: 'نتيجة سنوات سابقة لم تُقفل بعد في الفائض المرحّل:',
  balances: 'متوازنة',
  doesNotBalance: 'غير متوازنة',
};

export default ar;
