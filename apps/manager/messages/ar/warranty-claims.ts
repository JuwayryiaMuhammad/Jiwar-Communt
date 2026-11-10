import type { Translation } from '@jiwar/i18n';
import type en from '../en/warranty-claims.ts';

const ar: Translation<typeof en> = {
  title: 'مطالبات الضمان',
  description: 'مطالبات مقدّمة بموجب ضمانات الأصول. يُبتّ في كل مطالبة من صفحة أصلها.',
  status: 'الحالة',
  anyStatus: 'كل الحالات',
  empty: 'لا توجد مطالبات مطابقة',
  'col.opened': 'تاريخ الفتح',
  'col.asset': 'الأصل',
  'col.what': 'ما الذي تعطّل',
  'col.reference': 'المرجع',
  'col.status': 'الحالة',
  openAsset: 'افتح الأصل',
};

export default ar;
