import type { Translation } from '@jiwar/i18n';
import type en from '../en/ms-categories.ts';

const ar: Translation<typeof en> = {
  saved: 'تم حفظ {name}.',
  added: 'تمت إضافة {name}. حدد تخصصاتها ومستهدفات اتفاقية الخدمة بعد ذلك.',
  editTitle: 'تعديل {name}',
  newTitle: 'فئة جديدة',
  newDescription: 'ما يختاره الساكنون عند فتح بلاغ. تبدأ بالمستهدفات الافتراضية لاتفاقية الخدمة وبدون تخصص.',
  addCategory: 'أضف الفئة',
  defaultPriority: 'الأولوية الافتراضية',
  defaultPriorityHint: 'ما يحصل عليه البلاغ الجديد ما لم يحدد مقدّمه أو التوزيع غير ذلك.',
  commonAreas: 'يمكن استخدامها للمناطق المشتركة وليس للوحدات فقط',
  inUse: 'قيد الاستخدام. إلغاء التحديد يوقفها: لا بلاغ جديد تحتها، وتبقى بلاغاتها كما هي',
  specialtiesSaved: 'تم حفظ تخصصات {name}.',
  specialtiesTitle: 'تخصصات {name}',
  specialtiesDescription:
    'التوزيع التلقائي يعرض بلاغ هذه الفئة على الفني الذي لديه أحد هذه التخصصات فقط. وإذا لم يُحدَّد أي تخصص فلا يصلح أي فني، وتنتظر بلاغاتها موزّعًا.',
  addSpecialtyFirst: 'أضف تخصصًا أولًا من تبويب التخصصات.',
  newCategoryButton: 'فئة جديدة',
  empty: 'لا توجد فئات بعد',
  'col.category': 'الفئة',
  'col.code': 'الرمز',
  'col.priority': 'الأولوية الافتراضية',
  'col.where': 'المكان',
  'col.specialties': 'التخصصات',
  'col.responseResolution': 'الاستجابة / الحل',
  whereBoth: 'الوحدات والمناطق المشتركة',
  whereUnits: 'الوحدات فقط',
  noSpecialty: 'لا يوجد: بدون توزيع تلقائي',
  retiredSpecialty: 'تخصص موقوف',
  retired: 'موقوفة',
  specialtiesButton: 'التخصصات',
  changeTargets: 'تغيير المستهدفات',
};

export default ar;
