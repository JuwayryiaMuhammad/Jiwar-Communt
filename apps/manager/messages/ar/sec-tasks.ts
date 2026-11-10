import type { Translation } from '@jiwar/i18n';
import type en from '../en/sec-tasks.ts';

const ar: Translation<typeof en> = {
  title: 'مهام الحراس',
  description: 'المهمة التي تبقى مفتوحة عند نهاية الوردية تنتقل إلى موقع الوردية للحارس التالي.',
  shown: 'المهام المعروضة',
  'view.open': 'مفتوحة',
  'view.in_progress': 'قيد التنفيذ',
  'view.done': 'منتهية',
  'view.cancelled': 'ملغاة',
  newTask: 'مهمة جديدة',
  empty: 'لا توجد مهام',
  inspectUnit: 'معاينة الوحدة {code}',
  'col.task': 'المهمة',
  'col.for': 'مسندة إلى',
  'col.due': 'الموعد',
  'col.given': 'وقت الإسناد',
  carried: 'منقولة',
  detailTitle: 'مهمة',
  cancelTask: 'إلغاء المهمة',
  cancelTitle: 'إلغاء هذه المهمة؟',
  cancelled: 'تم إلغاء المهمة.',
  forLabel: 'مسندة إلى',
  takenBy: 'استلمها',
  guardNote: 'ملاحظة الحارس',
  givenBy: 'أسندها',
  photos: 'الصور',
  photo: 'صورة {n}',
};

export default ar;
