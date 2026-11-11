import type { Translation } from '@jiwar/i18n';
import type en from '../en/fin-tax-vat.ts';

const ar: Translation<typeof en> = {
  title: 'الإقرار الضريبي للقيمة المضافة',
  description:
    'ضريبة المخرجات على الفواتير، وضريبة المدخلات المستردة على فواتير الموردين، وصافي المستحق أو المرحَّل. يُقدَّم إقرار الشهر بعد أن يقفله دفتر الأستاذ، وبالترتيب.',
  settingsLink: 'إعدادات الضرائب',
  periodsLink: 'إقفال الشهور',
  months: 'الشهور',
  monthsHint: 'من الأحدث إلى الأقدم، بدءًا من الشهر الذي بدأت فيه الضريبة. لا ضريبة على ما قبله.',
  empty: 'الضريبة غير مفعّلة، أو لم تبدأ بعد',
  month: 'الشهر',
  open: 'مفتوح',
  ready: 'جاهز للإقرار',
  declared: 'تم الإقرار',
  taxableSales: 'المبيعات الخاضعة',
  outputVat: 'ضريبة المخرجات',
  taxablePurchases: 'المشتريات الخاضعة',
  inputVat: 'ضريبة المدخلات',
  carriedIn: 'مرحَّل من قبل',
  netDue: 'صافي المستحق',
  carriedOut: 'مرحَّل لما بعد',
  paid: 'المسدَّد',
  declaredOn: 'تاريخ الإقرار',
  declare: 'قدّم الإقرار',
  pay: 'سدّد {amount}',
  pdf: 'ملف PDF',
  workbook: 'ملف Excel',
  csv: 'ملف CSV',
  declareTitle: 'تقديم إقرار ضريبة {month}؟',
  declareDescription: 'تُقفل أرقامه، وتُخصم المدخلات من المخرجات، ولا يمكن بعده إعادة فتح الشهر في دفتر الأستاذ.',
  declareDone: 'تم تقديم إقرار ضريبة {month}.',
  payTitle: 'سداد ضريبة {month}',
};

export default ar;
