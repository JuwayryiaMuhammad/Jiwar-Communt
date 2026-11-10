import type { Translation } from '@jiwar/i18n';
import type en from '../en/fin-gl-periods.ts';

const ar: Translation<typeof en> = {
  title: 'إقفال الشهور',
  description: 'الشهر المُقفل لا يقبل قيودًا: التصحيح يكون بقيد عكسي في شهر مفتوح.',
  months: 'شهور دفتر الأستاذ',
  monthsHint: 'من الأحدث إلى الأقدم، بدءًا من شهر أول قيد.',
  month: 'الشهر',
  closed: 'تاريخ الإقفال',
  reopened: 'تاريخ إعادة الفتح',
  closeThrough: 'أقفل حتى هذا الشهر',
  reopen: 'أعد الفتح',
  closeTitle: 'الإقفال حتى {month}؟',
  closeDescription: 'يُقفل هذا الشهر وكل شهر مفتوح قبله. ولا يُؤرَّخ أي قيد في هذه الشهور بعد ذلك.',
  closeConfirm: 'أقفل',
  closeDone: 'تم الإقفال.',
  reopenTitle: 'إعادة فتح {month}',
  reopenDescription: 'يمكن بعدها تأريخ القيود فيه من جديد. يُسجَّل ذلك مع السبب.',
  reopenDone: 'تمت إعادة الفتح.',
};

export default ar;
