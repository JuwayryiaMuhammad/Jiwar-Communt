import type { Translation } from '@jiwar/i18n';
import type en from '../en/stock-stores.ts';

const ar: Translation<typeof en> = {
  added: 'تمت الإضافة.',
  retired: 'تم الإيقاف.',
  title: 'المخازن',
  description: 'الأماكن التي يحتفظ فيها مخزن الصيانة بقطع الغيار.',
  newStore: 'مخزن جديد',
  empty: 'لا توجد مخازن بعد',
  'col.code': 'الرمز',
  'col.name': 'الاسم',
  'col.status': 'الحالة',
  retiredBadge: 'موقوف',
  retire: 'أوقف',
  addStore: 'أضف المخزن',
  codeHint: 'فريد. لا يتغير أبدًا.',
  nameEn: 'الاسم (بالإنجليزية)',
  nameAr: 'الاسم (بالعربية)',
};

export default ar;
