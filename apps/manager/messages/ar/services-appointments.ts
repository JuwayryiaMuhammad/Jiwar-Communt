import type { Translation } from '@jiwar/i18n';
import type en from '../en/services-appointments.ts';

const ar: Translation<typeof en> = {
  title: 'المواعيد',
  description: 'لقاءات حجزها السكان مع الإدارة من ساعات العمل. تأكيد فترة أو اقتراح غيرها يُعد ردًا على الطلب.',
  shown: 'المواعيد المعروضة',
  'view.upcoming': 'القادمة',
  'view.to_confirm': 'بانتظار التأكيد',
  'view.all': 'الكل',
  holding: 'تحجز فترة',
  anyStatus: 'أي حالة',
  emptyToConfirm: 'لا توجد فترة بانتظار التأكيد',
  emptyAny: 'لا يوجد موعد مطابق',
  emptyHint: 'يحجز السكان من ساعات العمل المحددة في إعدادات الطلبات.',
  'col.when': 'الوقت',
  'col.how': 'الطريقة',
  'col.resident': 'الساكن',
  'col.request': 'الطلب',
  'pickedBy.staff': 'اختارتها الإدارة',
  'pickedBy.resident': 'اختارها الساكن',
};

export default ar;
