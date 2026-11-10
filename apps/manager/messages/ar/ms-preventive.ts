import type { Translation } from '@jiwar/i18n';
import type en from '../en/ms-preventive.ts';

const ar: Translation<typeof en> = {
  saved: 'تم حفظ {name}.',
  added: 'تمت إضافة {name}.',
  editTitle: 'تعديل {name}',
  newTitle: 'خدمة وقائية جديدة',
  newDescription: 'فحص دوري يستطيع الساكنون حجزه، مثل صيانة سخان المياه. يختارونه من قائمة ثم يحددون الموعد.',
  addService: 'أضف الخدمة',
  category: 'الفئة',
  categoryHint: 'فنيو هذه الفئة يقومون بالفحص، وتسري عليه مستهدفات SLA الخاصة بها.',
  retiredSuffix: '{name} (موقوفة)',
  position: 'الترتيب',
  positionHint: 'الترتيب الذي يراه الساكنون، من الأصغر إلى الأكبر (من 0 إلى 1000).',
  positionHintNew: 'الترتيب الذي يراه الساكنون، من الأصغر إلى الأكبر (من 0 إلى 1000). إن تُرك فارغًا فتأتي بعد الباقي.',
  inUse: 'قيد الاستخدام. إلغاء التحديد يوقفها: لا طلبات جديدة عليها، وتبقى حجوزاتها',
  newService: 'خدمة جديدة',
  empty: 'لا توجد خدمات وقائية بعد',
  emptyHint: 'لن يرى الساكنون أي فحص للحجز حتى تضيف واحدًا.',
  'col.position': 'الترتيب',
  'col.service': 'الخدمة',
  'col.code': 'الرمز',
  'col.category': 'الفئة',
  retired: 'موقوفة',
  retiredCategory: 'فئة موقوفة',
};

export default ar;
