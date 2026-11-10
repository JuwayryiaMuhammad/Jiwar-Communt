import type { Translation } from '@jiwar/i18n';
import type en from '../en/services-message-templates.ts';

const ar: Translation<typeof en> = {
  title: 'قوالب الرسائل',
  description: 'نصوص يكتبها المكتب كثيرًا، تُحفظ مرة واحدة. قوالب الإعلانات تبدأ مسودة جديدة؛ وقوالب الردود تُختار عند الرد على طلب.',
  newTemplate: 'قالب جديد',
  shown: 'القوالب المعروضة',
  'kind.announcement': 'الإعلانات',
  'kind.reply': 'الردود',
  saved: 'تم حفظ القالب.',
  deleted: 'حُذف القالب.',
  'col.name': 'الاسم',
  'col.words': 'النص',
  editTitle: 'تعديل القالب',
  name: 'الاسم',
  nameHint: 'خاص بالمجمع، ولا يتكرر.',
  titleEn: 'العنوان (بالإنجليزية)',
  wordsEn: 'النص (بالإنجليزية)',
  wordsAr: 'النص (بالعربية)',
};

export default ar;
