import type { Translation } from '@jiwar/i18n';
import type en from '../en/fin-late-notices.ts';

const ar: Translation<typeof en> = {
  title: 'إنذارات التأخير',
  description: 'إنذارات رسمية بالتأخر في السداد، وهي سجل المجمع: من استلم كل إنذار، وما يثبت أنه وصله وقرأه.',
  empty: 'لا توجد إنذارات بعد',
  notice: 'الإنذار',
  owed: 'المستحق',
  due: 'تاريخ الاستحقاق',
  issued: 'تاريخ الإصدار',
  proofs: 'الإثباتات',
  proofLine: 'سُلّم إلى {all} · أُرسل بالبريد إلى {emailed} · قرأه {read}',
  'cure.title': 'مهلة التدارك',
  'cure.label': 'عدد الأيام بعد تاريخ الاستحقاق',
  'cure.hint': 'الفاتورة التي ما زالت مستحقة بعد هذا العدد من الأيام من تاريخ استحقاقها، وليست محل اعتراض ولا ضمن خطة سداد، يصدر لها إنذار رسمي واحد.',
  'cure.invalid': 'عدد صحيح من {min} إلى {max}.',
  'cure.saved': 'تم حفظ مهلة التدارك.',
};

export default ar;
