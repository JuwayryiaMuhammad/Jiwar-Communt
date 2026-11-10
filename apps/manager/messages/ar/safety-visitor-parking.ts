import type { Translation } from '@jiwar/i18n';
import type en from '../en/safety-visitor-parking.ts';

const ar: Translation<typeof en> = {
  title: 'مواقف الزوار',
  description: 'حجوزات السكان لزوارهم. يرى الحارس ما هو قائم الآن وخلال الساعتين القادمتين.',
  day: 'اليوم',
  area: 'المنطقة',
  everyArea: 'كل المناطق',
  peak: '{area}: {peak} على الأكثر من {capacity}',
  empty: 'لا توجد مواقف زوار في هذا اليوم',
  'col.booking': 'الحجز',
  'col.when': 'الوقت',
  'col.area': 'المنطقة',
  'col.unit': 'الوحدة',
  'col.visitor': 'الزائر',
  'col.bookedBy': 'حجزه',
  'col.status': 'الحالة',
  span: 'من {from} إلى {to}',
  visitorPass: 'تصريح زيارة',
  erased: 'حساب محذوف',
  cancel: 'ألغِ',
  cancelled: 'تم الإلغاء.',
  cancelTitle: 'إلغاء {reference}؟',
  cancelDescription: 'يصبح المكان متاحًا من جديد، وترى الأسرة أن الحجز أُلغي.',
  cancelConfirm: 'ألغِ الحجز',
};

export default ar;
