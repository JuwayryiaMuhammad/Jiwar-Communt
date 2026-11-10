import type { Translation } from '@jiwar/i18n';
import type en from '../en/sec-places.ts';

const ar: Translation<typeof en> = {
  saved: 'تم حفظ {name}.',
  added: 'تمت إضافة {name}.',
  editTitle: 'تعديل {name}',
  newPlace: 'مكان جديد',
  defaultPlaceNote: 'مكان افتراضي: يسميه التطبيق بكلماته الخاصة، وتظهر أسماؤك أنت في لوحة التحكم هذه.',
  addPlace: 'إضافة مكان',
  nameEn: 'الاسم (بالإنجليزية)',
  nameAr: 'الاسم (بالعربية)',
  order: 'الترتيب',
  orderHint: 'الأقل أولًا (0–1000).',
  offeredAgain: 'عاد {name} إلى القائمة المعروضة.',
  retiredToast: 'تم إيقاف {name}.',
  note: 'تُعرض على السكان لطلب المساعدة في إمكانية الوصول والمرافقة والإبلاغ عن نشاط مشبوه.',
  empty: 'لا توجد أماكن',
  'col.place': 'المكان',
  'col.arabic': 'بالعربية',
  retire: 'إيقاف',
  restore: 'إعادة تفعيل',
};

export default ar;
