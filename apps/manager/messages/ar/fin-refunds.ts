import type { Translation } from '@jiwar/i18n';
import type en from '../en/fin-refunds.ts';

const ar: Translation<typeof en> = {
  title: 'الاستردادات',
  description: 'رصيد أُعيد إلى الوحدات. لاسترداد رصيد وحدة، افتح كشف حسابها واختر «استرداد الرصيد».',
  empty: 'لا توجد استردادات بعد',
  refund: 'الاسترداد',
  by: 'بواسطة',
  reference: 'المرجع',
  refundedOn: 'تاريخ السداد',
  recordedBy: 'سجّله',
  reversed: 'مُلغى',
  reverse: 'إلغاء',
  reversedToast: 'أُلغي الاسترداد {number}: عاد المبلغ رصيدًا للوحدة.',
  reverseTitle: 'إلغاء الاسترداد {number}؟',
  reverseDescription: 'يُسجَّل قيد جديد يعكسه دون تعديل أي شيء. يعود المبلغ رصيدًا للوحدة ويسدد ما عليها.',
};

export default ar;
