import type { Translation } from '@jiwar/i18n';
import type en from '../en/guard-patrol-report.ts';

const ar: Translation<typeof en> = {
  title: 'تقرير الدوريات',
  description: 'لكل مسار، الجولات المخططة في الفترة: 31 يومًا على الأكثر. ويحصي التقرير اليومي دوريات كل موقع أيضًا.',
  from: 'من',
  to: 'إلى',
  empty: 'لا توجد جولات في هذه الفترة',
  'col.route': 'المسار',
  'col.post': 'الموقع',
  'col.scheduled': 'مجدولة',
  'col.adhoc': 'غير مجدولة',
  'col.done': 'تمت',
  'col.late': 'متأخرة',
  'col.missed': 'فائتة',
  'col.incomplete': 'غير مكتملة',
  'col.manual': 'يدويًا',
  'col.suspect': 'بعيدة',
  'col.offline': 'أُرسلت متأخرة',
  'col.avg': 'متوسط الدقائق',
};

export default ar;
