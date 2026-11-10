import type { Translation } from '@jiwar/i18n';
import type en from '../en/ms-safety.ts';

const ar: Translation<typeof en> = {
  hazardsDescription: 'لا يبدأ العمل فيها إلا بتصريح معتمد وغير منتهٍ لكل خطر من هذه الأخطار.',
  published: 'تم نشر الإصدار {version}: يُقرّ الفنيون به قبل أن يبدؤوا.',
  instructionsTitle: 'تعليمات السلامة · {name}',
  instructionsDescription:
    'كل تغيير يصبح إصدارًا جديدًا، والإصدار لا يتغير أبدًا. يُقرّ الفني بالإصدار الحالي لكل بلاغ قبل بدء العمل أو استئنافه.',
  publish: 'انشر الإصدار التالي',
  latest: 'الإصدار {version}، {when}: {text}',
  noneYet: 'لا توجد تعليمات بعد.',
  inEnglish: 'بالإنجليزية',
  inArabic: 'بالعربية',
  noPermit: 'لا يحتاج تصريحًا',
  categories: 'الفئات',
  emptyCategories: 'لا توجد فئات',
  'col.category': 'الفئة',
  'col.permit': 'يحتاج تصريحًا لـ',
  hazards: 'الأخطار',
  instructions: 'التعليمات',
  assetTypes: 'أنواع الأصول',
  emptyTypes: 'لا توجد أنواع أصول',
  'col.assetType': 'نوع الأصل',
  hazardsTitle: 'ما يحتاج {name} تصريحًا له',
};

export default ar;
