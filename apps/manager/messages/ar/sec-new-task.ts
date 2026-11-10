import type { Translation } from '@jiwar/i18n';
import type en from '../en/sec-new-task.ts';

const ar: Translation<typeof en> = {
  given: 'تم إسناد المهمة، ويُبلَّغ الحارس أو الحراس العاملون هناك.',
  title: 'مهمة جديدة',
  description: 'لحارس واحد، أو لمن يعمل في وردية عند بوابة أو منطقة.',
  giveTask: 'إسناد المهمة',
  inspectionDue: 'معاينة الوحدة {unit}، وقد حان موعد جولتها.',
  inspectionAsked: 'معاينة الوحدة {unit}، بناءً على طلب مالكها.',
  'kind.custom': 'مهمة',
  'kind.closed_unit_inspection': 'معاينة وحدة مغلقة',
  titleLabel: 'العنوان',
  unitHint: 'في وضع الإغلاق: فعّله أهل الوحدة.',
  details: 'التفاصيل',
  forLabel: 'مسندة إلى',
  gateOrZone: 'بوابة أو منطقة',
  oneGuard: 'حارس واحد',
  guard: 'الحارس',
  post: 'الموقع',
  due: 'الموعد',
};

export default ar;
