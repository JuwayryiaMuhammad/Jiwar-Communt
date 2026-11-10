import type { Translation } from '@jiwar/i18n';
import type en from '../en/gov-handover.ts';

const ar: Translation<typeof en> = {
  title: 'مذكرة تسليمي',
  description: 'قبل أن تغادر: ما ينبغي أن يعرفه من يأتي بعدك. تُسلَّم مرة واحدة، مع ما ينتظر المكتب وقتها.',
  draftSaved: 'حُفظت كمسودة.',
  delivered: 'تم التسليم. أُبلغ مجلس الإدارة والمديرون الآخرون.',
  lastDelivered: 'سُلمت مذكرتك الأخيرة {when}. أي ملاحظة جديدة تبدأ مسودة جديدة.',
  yourDraft: 'مسودتك',
  newHandover: 'مذكرة تسليم جديدة',
  notes: 'الملاحظات',
  notesHint: 'لا تكتب اسم أي ساكن',
  saveDraft: 'احفظ المسودة',
  deliver: 'سلّم',
  deliverTitle: 'تسليم المذكرة؟',
  deliverDescription: 'تُحفظ كما هي من الآن فصاعدًا، مع لقطة بما ينتظر المكتب الآن.',
};

export default ar;
