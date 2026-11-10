import type { Translation } from '@jiwar/i18n';
import type en from '../en/ms-dispatch.ts';

const ar: Translation<typeof en> = {
  'weight.weightAssigned': 'مُسنَد',
  'weightHint.weightAssigned': 'بلاغ لم يبدأ فيه الفني.',
  'weight.weightInProgress': 'قيد التنفيذ',
  'weightHint.weightInProgress': 'بلاغ يجري العمل عليه.',
  'weight.weightOnHold': 'معلّق',
  'weightHint.weightOnHold': '0: البلاغ المنتظر لقطع الغيار أو للساكن لا يُحتسب عليه وقت الآن.',
  'weight.multiplierNormal': 'معامل العادي',
  'weightHint.multiplierNormal': 'يُضرب في وزن الحالة، للبلاغ ذي الأولوية العادية.',
  'weight.multiplierUrgent': 'معامل العاجل',
  'weight.multiplierEmergency': 'معامل الطوارئ',
  turnedOn: 'التوزيع التلقائي مفعّل. تُعرض البلاغات المنتظرة الآن.',
  turnedOff: 'التوزيع التلقائي متوقف. البلاغات الجديدة تنتظر موزّعًا.',
  weightsSaved: 'تم حفظ أوزان الحمل.',
  automatic: 'التوزيع التلقائي',
  on: 'مفعّل',
  off: 'متوقف',
  onBody:
    'يذهب البلاغ الجديد إلى أقل الفنيين المتاحين حملًا ممن لديه تخصص تحتاجه فئة البلاغ. والبلاغ الذي لا يصلح له أحد يبقى في الطابور، ويُبلَّغ الموزّعون.',
  offBody: 'ينتظر كل بلاغ في الطابور حتى يسنده موزّع. وزرّ «أسنِد تلقائيًا» في البلاغ يجرّب المحرك لهذا البلاغ وحده.',
  techsAvailable: 'الفنيون المتاحون الآن: {available} من {total}',
  techsUnskilled: 'فنيون بلا تخصص ولن يُعرض عليهم شيء: {n}',
  categoriesBare: 'فئات بلا تخصص، لذلك تنتظر بلاغاتها دائمًا موزّعًا: {n} ({names})',
  queue: '{n, plural, other {البلاغات المنتظرة في الطابور: {queue}}}',
  turnOff: 'إيقاف',
  turnOn: 'تفعيل',
  weights: 'أوزان الحمل',
  weightsHint:
    'حمل الفني هو مجموع بلاغاته المفتوحة، كلٌّ بوزن حالته مضروبًا في معامل أولويته. يختار التوزيع التلقائي الأقل حملًا، وتعرضه تبويبة الفنيين.',
  discard: 'تجاهل التعديلات',
  saveWeights: 'احفظ الأوزان',
  offTitle: 'إيقاف التوزيع التلقائي؟',
  onTitle: 'تفعيل التوزيع التلقائي؟',
  confirmOffBody: 'ستنتظر البلاغات الجديدة في الطابور حتى يسندها موزّع. أما البلاغات المُسنَدة بالفعل فتبقى مع فنييها.',
  confirmOnBody:
    'يعمل هذا فورًا: يُسنَد حتى 50 من البلاغات المنتظرة في الطابور{now} في الحال، ثم كل بلاغ جديد بعد ذلك. ويُبلَّغ الفنيون بكل بلاغ.',
  nowSuffix: ' ({queue} الآن)',
  noTechNow: 'لا يوجد فني متاح الآن، لذلك لن يُسنَد شيء حاليًا.',
  turnOnAssign: 'فعّل وأسند الطابور',
  checkFirst: 'راجع التخصصات أولًا: {parts}. ستظل بلاغاتها تنتظر.',
  unskilledPart: 'فنيون بلا تخصص: {n}',
  barePart: 'فئات بلا تخصص: {n}',
};

export default ar;
