import type { Translation } from '@jiwar/i18n';
import type en from '../en/fin-collector-visits.ts';

const ar: Translation<typeof en> = {
  title: 'زيارات المحصّلين',
  description: 'نقدية يحصّلها المحصّلون الميدانيون من الوحدات بناءً على طلب السكان.',
  'filter.open': 'المفتوحة',
  'filter.cancelled': 'الملغاة',
  none: 'لا يوجد',
  'col.window': 'الموعد',
  'col.expected': 'المتوقع',
  'col.why': 'السبب',
  reassign: 'تغيير المحصّل',
  assign: 'تعيين',
  callOff: 'إلغاء الزيارة',
  assignTitle: 'محصّل للوحدة {unit}',
  assigned: 'تم التعيين: أُبلغ المحصّل والساكن.',
  collector: 'المحصّل',
  collectorHint: 'الموظفون الذين يشمل دورهم زيارات التحصيل.',
  choose: 'اختر…',
  callOffTitle: 'إلغاء الزيارة إلى الوحدة {unit}',
  calledOff: 'تم إلغاء الزيارة.',
  keepIt: 'أبقِها',
  marginTitle: 'هامش المحصّل',
  marginSaved: 'تم حفظ الهامش.',
  marginLabel: 'فوق ما تدين به الوحدة، بالجنيه',
  marginHint:
    'يجوز أن يزيد المبلغ المستلم قليلًا إذا كان مبلغًا مقربًا؛ وما زاد على هذا الهامش يُرفض حتى لا يتسبب رقم مكتوب بالخطأ في رصيد دائن كبير. من 0 إلى 1000.',
};

export default ar;
