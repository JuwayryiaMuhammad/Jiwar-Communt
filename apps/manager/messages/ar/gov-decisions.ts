import type { Translation } from '@jiwar/i18n';
import type en from '../en/gov-decisions.ts';

const ar: Translation<typeof en> = {
  published: 'نُشر للملاك ضمن إعلاناتهم. لم يُرسل إشعار لأحد.',
  publishTitle: 'النشر باسم مجلس الإدارة',
  publishDescription: 'للملاك، كإعلان من مجلس الإدارة يظهر فورًا. ما دام هناك مجلس قائم.',
  publish: 'انشر',
  what: 'النوع',
  'kind.decision': 'قرار',
  'kind.minutes': 'محضر',
  optionDecision: 'قرار',
  optionMinutes: 'محضر اجتماع',
  decidedOrMet: 'تاريخ القرار أو الاجتماع',
  titleLabel: 'العنوان',
  text: 'النص',
  pdfAttached: 'يوجد ملف PDF مرفق.',
  attachPdf: 'أرفق ملف PDF',
  archived: 'أُرشف المنشور: أُزيل نهائيًا.',
  title: 'القرارات',
  description: 'قرارات مجلس الإدارة ومحاضره كما يقرؤها الملاك في إعلاناتهم.',
  nothing: 'لم يُنشر شيء بعد',
  'col.decided': 'تاريخ القرار',
  'col.pdf': 'ملف PDF',
  'col.published': 'تاريخ النشر',
  archive: 'أرشِف',
};

export default ar;
