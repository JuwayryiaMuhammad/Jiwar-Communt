import type { Translation } from '@jiwar/i18n';
import type en from '../en/ms-checklists.ts';

const ar: Translation<typeof en> = {
  itemN: 'البند {n}',
  labelEn: 'العنوان (بالإنجليزية)',
  labelAr: 'العنوان (بالعربية)',
  metric: 'المقياس',
  unit: 'الوحدة',
  min: 'الحد الأدنى',
  max: 'الحد الأقصى',
  required: 'إلزامي',
  addItem: 'أضف بندًا',
  saved: 'تم حفظ {name}.',
  savedVersion: 'تم حفظ {name} (الإصدار {version}).',
  editTitle: 'تعديل {name}',
  newTitle: 'قائمة فحص جديدة',
  editDescription: 'تغيير البنود ينشئ إصدارًا جديدًا: قوائم الفحص التي يجري تعبئتها الآن تحتفظ بإصدارها.',
  for: 'الغرض',
  'purpose.any': 'الأعمال المخططة والفحوصات',
  'purpose.pm': 'الأعمال المخططة',
  'purpose.inspection': 'الفحوصات',
  'purposeShort.any': 'كلاهما',
  requireScan: 'يجب مسح العلامة قبل الإرسال',
  newChecklist: 'قائمة فحص جديدة',
  empty: 'لا توجد قوائم فحص بعد',
  'col.checklist': 'قائمة الفحص',
  'col.for': 'الغرض',
  'col.version': 'الإصدار',
  'col.scan': 'المسح',
  scanRequired: 'إلزامي',
  retired: 'موقوفة',
};

export default ar;
