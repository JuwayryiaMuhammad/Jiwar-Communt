import type { Translation } from '@jiwar/i18n';
import type en from '../en/maint-common.ts';

const ar: Translation<typeof en> = {
  erased: 'حساب محذوف',
  'place.unit': 'الوحدة {code}',
  'place.unitRoom': 'الوحدة {code} · {room}',
  'place.common': 'منطقة مشتركة',
  'place.commonNamed': 'منطقة مشتركة · {area}',
  overdue: 'متأخر',
  paused: 'متوقف مؤقتًا',
  onTime: 'ضمن المهلة',
  escalated: 'مصعَّد',
  escalatedTitle: 'صعّده ساكن في {when}',
  'due.response': 'مهلة الاستجابة {when}',
  'due.resolution': 'مهلة الحل {when}',
  'dueTitle.response': 'تنتهي مهلة الاستجابة في {when}',
  'dueTitle.resolution': 'تنتهي مهلة الحل في {when}',
  'picker.select': 'اختر فنيًا…',
  'picker.loading': 'جارٍ تحميل الفنيين…',
  'picker.technician': 'فني',
  'picker.option': '{name} · {state, select, available {متاح} other {غير متاح}} · بلاغات مفتوحة: {n}',
};

export default ar;
