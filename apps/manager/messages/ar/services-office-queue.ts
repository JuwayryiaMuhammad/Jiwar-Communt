import type { Translation } from '@jiwar/i18n';
import type en from '../en/services-office-queue.ts';

const ar: Translation<typeof en> = {
  movedToast: 'نُقل {number} إلى موضوعه الجديد.',
  convertedToast: 'تحول {number} إلى {ticket}، وأُبلغ الساكن.',
  changeTopic: 'غيّر الموضوع',
  convert: 'حوّله إلى بلاغ',
  topicTitle: 'موضوع آخر للطلب {number}',
  topicDescription: 'تُحسب مدة الرد وفق مدة الموضوع الجديد من بداية هذه الدورة. ويُبلَّغ مسؤولو الموضوع الجديد إن لم يكن الطلب مسندًا إلى أحد.',
  move: 'انقل',
  topic: 'الموضوع',
  choose: 'اختر…',
  convertTitle: 'تحويل {number} إلى بلاغ',
  convertDescription: 'يُغلق الطلب نهائيًا ويستمر العمل في البلاغ. ويُبلَّغ الساكن برقمه.',
  openTicket: 'افتح البلاغ',
  ticket: 'البلاغ',
  residentTicket: 'بلاغ صيانة للساكن في {unit}',
  workOrder: 'أمر عمل في منطقة مشتركة',
  commonArea: 'معرّف المنطقة المشتركة',
  commonAreaHint: 'المنطقة المشتركة التي بها العطل.',
  category: 'الفئة',
  whatToDo: 'المطلوب عمله',
  remindedToast:
    '{n, plural, =0 {لم يُذكَّر أحد.} one {ذُكِّر شخص واحد.} two {ذُكِّر شخصان.} few {ذُكِّر # أشخاص.} many {ذُكِّر # شخصًا.} other {ذُكِّر # شخص.}}',
  told: 'أُبلغوا عند النشر',
  toldHint: '{n} قرأوه في صندوق الوارد',
  reminded: 'التذكير',
  remindedOn: 'في {when}',
  notYet: 'ليس بعد',
  pushes: 'الإشعارات الفورية',
  pushesSent: 'أُرسل {n}',
  pushesHint: 'فشل {failed}، ومتبقٍ {pending}',
  opened: 'فتحوه',
  openedOf: '{n} من {total}',
  remindButton: 'ذكّر من لم يفتحه',
  remindTitle: 'تذكير من لم يفتحه؟',
  remindDescription: 'مرة واحدة فقط. يُرسل إشعار الآن لكل من وُجّه إليه ولم يفتحه.',
  remind: 'ذكّر',
};

export default ar;
