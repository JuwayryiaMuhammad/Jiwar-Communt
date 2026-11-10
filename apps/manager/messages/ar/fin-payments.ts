import type { Translation } from '@jiwar/i18n';
import type en from '../en/fin-payments.ts';

const ar: Translation<typeof en> = {
  title: 'الدفعات',
  description: 'كل دفعة تسدد أقدم الفواتير المستحقة أولًا. وما زاد عن مستحق الوحدة يصبح رصيدًا لها يُخصم من فواتيرها التالية.',
  record: 'سجّل دفعة',
  channel: 'القناة',
  office: 'في المكتب',
  online: 'عبر الإنترنت',
  method: 'الطريقة',
  any: 'أي',
  paidFrom: 'الدفع من',
  paidTo: 'إلى',
  empty: 'لا توجد دفعات مطابقة',
  receipt: 'الإيصال',
  paidOn: 'تاريخ الدفع',
  reversed: 'مُلغاة',
  credit: 'رصيد {amount}',
  recorded: 'وقت التسجيل',
};

export default ar;
