import type { Translation } from '@jiwar/i18n';
import type en from '../en/maint-technicians.ts';

const ar: Translation<typeof en> = {
  technician: 'الفني',
  thisTechnician: 'هذا الفني',
  specialtiesSaved: 'تم حفظ تخصصات {name}.',
  specialtiesTitle: 'تخصصات {name}',
  specialtiesDescription:
    'لا يعرض التوزيع التلقائي البلاغ إلا على الفنيين الذين لديهم تخصص تحتاجه فئته. إن لم تختر أي تخصص تُزال كلها.',
  noSpecialties: 'لا توجد تخصصات في المجمع بعد.',
  retired: '{name} (لم يعد مستخدمًا)',
  availabilitySaved: '{name} الآن {state, select, available {متاح} other {غير متاح}}.',
  empty: 'لا يوجد فنيون بعد',
  emptyHint: 'أضف حساب موظف بدور «فني» من صفحة الموظفين.',
  'col.technician': 'الفني',
  'col.availability': 'الإتاحة',
  'col.specialties': 'التخصصات',
  'col.open': 'البلاغات المفتوحة',
  'col.workload': 'عبء العمل',
  workloadHint: 'البلاغات المفتوحة موزونة حسب الحالة والأولوية: ما يوازنه التوزيع التلقائي.',
  since: 'منذ {when}',
  specialties: 'التخصصات',
  setUnavailable: 'اجعله غير متاح',
  setAvailable: 'اجعله متاحًا',
  unavailableTitle: 'جعل {name} غير متاح؟',
  unavailableDescription: 'يتوقف التوزيع التلقائي عن عرض البلاغات عليه. تبقى بلاغاته الحالية معه حتى تعيد إسنادها.',
};

export default ar;
