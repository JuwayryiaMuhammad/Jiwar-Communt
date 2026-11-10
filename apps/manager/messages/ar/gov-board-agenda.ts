import type { Translation } from '@jiwar/i18n';
import type en from '../en/gov-board-agenda.ts';

const ar: Translation<typeof en> = {
  title: 'مقترحات جدول الأعمال',
  description:
    'موضوعات طلب الملاك من مجلس الإدارة تناولها. يقبل العضو الحالي كل مقترح أو يرفضه، مرة واحدة؛ والقبول لا يُلزم المجلس بشيء.',
  'view.open': 'للرد',
  'view.accepted': 'مقبولة',
  'view.declined': 'مرفوضة',
  'view.withdrawn': 'مسحوبة',
  nothing: 'لا يوجد شيء هنا',
  'col.proposal': 'المقترح',
  'col.proposed': 'تاريخ التقديم',
  titleErased: 'حُذف: حُذف حساب مقدّمه',
  proposal: 'المقترح',
  accept: 'اقبل',
  decline: 'ارفض',
  proposed: 'تاريخ التقديم',
  theProposal: 'نص المقترح',
  bodyErased: 'حُذف: حُذف حساب مقدّمه.',
  answered: 'تاريخ الرد',
  boardNote: 'ملاحظة مجلس الإدارة',
  withdrawn: 'تاريخ السحب',
  acceptedToast: 'قُبل المقترح وأُبلغ مقدّمه.',
  declinedToast: 'رُفض المقترح وأُبلغ مقدّمه.',
  acceptTitle: 'قبول هذا المقترح؟',
  declineTitle: 'رفض هذا المقترح؟',
  decideDescription: 'مرة واحدة، باسم مجلس الإدارة. يقرأ مقدّم المقترح ملاحظتك: لا تذكر فيها اسم أحد.',
  why: 'السبب',
  chooseReason: 'اختر سببًا',
  note: 'ملاحظة لمقدّم المقترح (اختياري)',
};

export default ar;
