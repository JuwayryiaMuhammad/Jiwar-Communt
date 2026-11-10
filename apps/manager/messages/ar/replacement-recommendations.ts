import type { Translation } from '@jiwar/i18n';
import type en from '../en/replacement-recommendations.ts';

const ar: Translation<typeof en> = {
  title: 'الاستبدال',
  description: 'ما يوصي الفنيون باستبداله، ولماذا.',
  status: 'الحالة',
  'status.pending': 'بانتظار القرار',
  'status.accepted': 'مقبولة',
  'status.declined': 'مرفوضة',
  accept: 'اقبل',
  accepted: 'تم القبول.',
  declined: 'تم الرفض.',
  empty: 'لا شيء بانتظار القرار',
  'col.asset': 'الأصل',
  'col.why': 'السبب',
  'col.note': 'ملاحظة',
  'col.when': 'التاريخ',
  'col.status': 'الحالة',
  statusWithReason: '{status} (السبب: {reason})',
  declineTitle: 'رفض التوصية',
};

export default ar;
