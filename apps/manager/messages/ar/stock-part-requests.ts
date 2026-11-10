import type { Translation } from '@jiwar/i18n';
import type en from '../en/stock-part-requests.ts';

const ar: Translation<typeof en> = {
  reserved: 'تم الحجز، ويُبلَّغ الفني.',
  issued: 'تم الصرف على تكاليف البلاغ.',
  declined: 'تم الرفض.',
  title: 'طلبات القطع',
  description: 'ما يطلبه الفنيون من المخزن، من الأقدم إلى الأحدث.',
  status: 'الحالة',
  'status.open': 'مفتوحة',
  'status.reserved': 'محجوزة',
  'status.issued': 'مصروفة',
  'status.declined': 'مرفوضة',
  'status.cancelled': 'ملغاة',
  empty: 'لا توجد طلبات',
  'col.ticket': 'البلاغ',
  'col.item': 'الصنف',
  'col.quantity': 'الكمية',
  'col.status': 'الحالة',
  'col.asked': 'تاريخ الطلب',
  open: 'افتح',
  item: 'الصنف',
  reserve: 'احجز',
  issue: 'اصرف',
  decline: 'ارفض',
  reserveTitle: 'حجز القطعة',
  reserveDescription: 'تُحجز في المخزن للبلاغ حتى تُصرف أو يُفرج عنها.',
  store: 'المخزن',
  declineTitle: 'رفض الطلب',
};

export default ar;
