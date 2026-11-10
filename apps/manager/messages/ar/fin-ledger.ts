import type { Translation } from '@jiwar/i18n';
import type en from '../en/fin-ledger.ts';

const ar: Translation<typeof en> = {
  title: 'دفتر الأستاذ',
  description: 'كل فاتورة وإشعار دائن ودفعة ومبلغ مسترد في الفترة، مع ما عُكس منها، من الأقدم إلى الأحدث.',
  exportCsv: 'تصدير CSV',
  any: 'أي',
  empty: 'لا شيء في هذه الفترة',
  day: 'اليوم',
  number: 'الرقم',
  related: 'المرتبط',
  how: 'الطريقة',
  debit: 'مدين',
  credit: 'دائن',
  moved: 'المنقول',
};

export default ar;
