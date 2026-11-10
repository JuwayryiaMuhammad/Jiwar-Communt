import type { Translation } from '@jiwar/i18n';
import type en from '../en/fin-unit-statement.ts';

const ar: Translation<typeof en> = {
  back: 'الفواتير',
  title: 'كشف حساب الوحدة',
  unitTitle: 'الوحدة {code}',
  onlineOn: 'يستطيع ساكنوها الدفع عبر الإنترنت.',
  onlineOff: 'الدفع عبر الإنترنت متوقف في هذا المجمع.',
  issue: 'أصدر فاتورة',
  refund: 'استرداد الرصيد',
  record: 'سجّل دفعة',
  owed: 'المستحق',
  credit: 'الرصيد الدائن',
  oldestFirst: 'المستحق، الأقدم استحقاقًا أولًا',
  nothingOwed: 'لا شيء مستحق',
  invoice: 'الفاتورة',
  due: 'الاستحقاق',
  latest: 'آخر الحركات',
  noActivity: 'لا حركات بعد',
  number: 'الرقم',
  when: 'الوقت',
  withRelease: '{amount} (عاد {released} إلى الرصيد)',
};

export default ar;
