import type { Translation } from '@jiwar/i18n';
import type en from '../en/sec-reports.ts';

const ar: Translation<typeof en> = {
  title: 'التقرير الأمني اليومي',
  description:
    'لكل بوابة ومنطقة: الورديات والتأخير والغياب والمهام والطوارئ وخدمات البوابة والزوار والدوريات، والحوادث والمخالفات المسجلة على الحراس العاملين هناك.',
  day: 'اليوم',
  gate: 'البوابة',
  everyPost: 'كل البوابات والمناطق',
  exportCsv: 'تصدير CSV',
  empty: 'لا توجد بوابات',
  'col.post': 'الموقع',
  'col.shifts': 'الورديات',
  'col.slots': 'الفترات المغطاة',
  'col.late': 'المتأخرون',
  'col.absent': 'الغائبون',
  'col.tasks': 'المهام المنجزة / المفتوحة',
  'col.emergencies': 'الطوارئ',
  'col.services': 'خدمات البوابة',
  'col.visitors': 'الزوار',
  'col.patrols': 'الدوريات المنفذة / المجدولة',
  'col.missed': 'الفائتة / غير المكتملة',
  'col.incidents': 'الحوادث',
  'col.violations': 'المخالفات',
  patrolsTitle: 'متأخرة {late} · فائتة {missed} · غير مكتملة {incomplete}',
  shiftsTitle: '{post} · الورديات',
  emptyShifts: 'لا توجد ورديات',
  'shift.guard': 'الحارس',
  'shift.started': 'بدأت',
  'shift.ended': 'انتهت',
  'shift.late': 'التأخير',
  'shift.overtime': 'الوقت الإضافي',
  onShift: 'في الوردية',
  onTime: 'في الموعد',
  unscheduled: 'بلا جدول',
  unscheduledMinutes: 'بلا جدول: {time}',
};

export default ar;
