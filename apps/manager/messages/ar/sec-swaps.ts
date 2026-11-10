import type { Translation } from '@jiwar/i18n';
import type en from '../en/sec-swaps.ts';

const ar: Translation<typeof en> = {
  title: 'تبديل الورديات',
  description: 'وافق عليها الزميل، والقرار لك بالموافقة أو الرفض. وإذا بدأت إحدى الفترتين قبل ذلك ينتهي التبديل.',
  shown: 'التبديلات المعروضة',
  'view.accepted': 'بانتظار قرارك',
  'view.requested': 'بانتظار الزميل',
  'view.approved': 'تمت الموافقة',
  emptyToDecide: 'لا شيء بانتظار قرارك',
  empty: 'لا توجد تبديلات',
  'col.askedBy': 'طلبه',
  'col.slot': 'فترته',
  'col.colleague': 'الزميل',
  'col.exchange': 'في المقابل',
  'col.reason': 'السبب',
  'col.asked': 'وقت الطلب',
  cover: 'لا شيء: تغطية',
  approve: 'موافقة',
  reject: 'رفض',
  approved: 'تمت الموافقة، وانتقلت الفترتان إلى حارسيهما الجديدين.',
  rejected: 'تم الرفض، وسيُبلَّغ الحارسان.',
  rejectTitle: 'رفض هذا التبديل؟',
  rejectDescription: 'تبقى الفترتان مع حارسيهما.',
};

export default ar;
