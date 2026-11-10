import type { Translation } from '@jiwar/i18n';
import type en from '../en/stock.ts';

const ar: Translation<typeof en> = {
  added: 'تمت إضافة {sku}.',
  newTitle: 'صنف جديد',
  addItem: 'أضف الصنف',
  sku: 'رمز الصنف (SKU)',
  skuHint: 'فريد، مثل VALVE-15. لا يتغير أبدًا.',
  unit: 'وحدة القياس',
  nameEn: 'الاسم (بالإنجليزية)',
  nameAr: 'الاسم (بالعربية)',
  reorderLevel: 'حد إعادة الطلب',
  reorderHint: 'يُبلَّغ أمين المخزن عندما ينخفض المخزون إلى هذا الحد.',
  title: 'المخزون',
  description: 'مخزن الصيانة: الأصناف، وما يحتفظ به كل مخزن، وطلبات الفنيين لقطع الغيار.',
  partRequests: 'طلبات القطع',
  stores: 'المخازن',
  newItem: 'صنف جديد',
  show: 'عرض',
  'show.all': 'الكل',
  'show.below': 'يحتاج إعادة طلب',
  empty: 'لا توجد أصناف بعد',
  'col.sku': 'رمز الصنف',
  'col.name': 'الاسم',
  'col.held': 'المتوفر',
  'col.reserved': 'المحجوز',
  'col.cost': 'متوسط التكلفة',
  'col.status': 'الحالة',
  retired: 'موقوف',
  reorder: 'أعد الطلب',
};

export default ar;
