import type { Translation } from '@jiwar/i18n';
import type en from '../en/fin-disputes.ts';

const ar: Translation<typeof en> = {
  title: 'الاعتراضات',
  description: 'اعتراضات السكان على الفواتير. يُبَتّ في كل اعتراض مرة واحدة، ويُبلَّغ الساكن الذي قدّمه.',
  shown: 'الاعتراضات المعروضة',
  'view.open': 'المفتوحة',
  'view.accepted': 'المقبولة',
  'view.rejected': 'المرفوضة',
  none: 'لا توجد اعتراضات',
  'col.invoice': 'الفاتورة',
  'col.owed': 'المستحق',
  'col.opened': 'تاريخ الفتح',
  dispute: 'اعتراض',
  detailTitle: 'اعتراض على الفاتورة {invoice} · الوحدة {unit}',
  detailDescription: '{reason} · فُتح {when}',
  accept: 'قبول',
  reject: 'رفض',
  owesNow: 'المستحق على الفاتورة الآن',
  words: 'كلام الساكن',
  erased: 'حُذف مع حساب الساكن',
  decision: 'القرار',
  credited: 'أُضيف رصيد دائن {amount} ({number})',
  photoAlt: 'صورة الساكن',
  frozen: 'ما دام الاعتراض مفتوحًا تُجمَّد الفاتورة: لا تذكير ولا دفعة تحمل رقمها، ولا يسدّدها رصيد الوحدة.',
  acceptedToast: 'تم القبول: أُضيف رصيد دائن {amount} ({number}). وأُبلغ الساكن.',
  rejectedToast: 'تم الرفض. أُبلغ الساكن، ولم تعد الفاتورة مجمّدة.',
  acceptTitle: 'قبول الاعتراض',
  acceptDescription: 'يخصم إشعار دائن المبلغ من الفاتورة. وما زاد على المتبقي منها من مبالغ مدفوعة يعود إلى رصيد الوحدة.',
  acceptAndCredit: 'اقبل وأضف الرصيد',
  creditEgp: 'مبلغ الرصيد بالجنيه',
  rejectTitle: 'رفض الاعتراض؟',
  rejectDescription: 'تبقى الفاتورة كما هي ولا تعود مجمّدة، ويُبلَّغ الساكن.',
};

export default ar;
