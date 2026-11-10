import type { Translation } from '@jiwar/i18n';
import type en from '../en/audit-log.ts';

const ar: Translation<typeof en> = {
  title: 'سجل المراجعة',
  description: 'كل تغيير في الكمبوند، يُضاف إليه ولا يُعدَّل. تُذكر الأسماء بالمعرّف فقط، ولا تُحفظ فيه بيانات شخصية.',
  action: 'الإجراء',
  actionHint: 'بالنص الكامل، مثل resident.created',
  targetType: 'نوع الهدف',
  targetTypeHint: 'مثل account أو unit',
  reset: 'إعادة ضبط',
  emptyFiltered: 'لا يوجد سجل يطابق هذه التصفية',
  empty: 'لم يُسجَّل شيء بعد',
  when: 'الوقت',
  by: 'بواسطة',
  target: 'الهدف',
  changes: 'التغييرات',
};

export default ar;
