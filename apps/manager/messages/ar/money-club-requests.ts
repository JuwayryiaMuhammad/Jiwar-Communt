import type { Translation } from '@jiwar/i18n';
import type en from '../en/money-club-requests.ts';

const ar: Translation<typeof en> = {
  title: 'طلبات النادي',
  description: 'باقات طلبها السكان. يُستحق سعر كل منها على فاتورة الوحدة، وبعد الدفع يبدأ الاشتراك أو يُمدَّد تلقائيًا.',
  'status.requested': 'بانتظار الدفع',
  'status.paid': 'مدفوع',
  'status.cancelled': 'ملغى',
  empty: 'لا توجد طلبات هنا.',
  'col.unit': 'الوحدة',
  'col.price': 'السعر',
  'col.status': 'الحالة',
  'col.asked': 'تاريخ الطلب',
  'col.paid': 'تاريخ الدفع',
};

export default ar;
