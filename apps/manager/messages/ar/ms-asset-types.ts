import type { Translation } from '@jiwar/i18n';
import type en from '../en/ms-asset-types.ts';

const ar: Translation<typeof en> = {
  saved: 'تم حفظ {name}.',
  editTitle: 'تعديل {name}',
  newTitle: 'نوع أصل جديد',
  addType: 'أضف النوع',
  category: 'الفئة',
  categoryHint: 'فنيو هذه الفئة يعملون على هذه الأصول.',
  expectedLife: 'العمر المتوقع (بالسنوات)',
  inUse: 'قيد الاستخدام',
  newType: 'نوع جديد',
  'col.type': 'النوع',
  'col.code': 'الرمز',
  'col.life': 'العمر المتوقع',
  retired: 'موقوف',
  years: '{n, plural, one {سنة واحدة} two {سنتان} few {# سنوات} many {# سنة} other {# سنة}}',
};

export default ar;
