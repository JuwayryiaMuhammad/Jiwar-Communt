import type { Translation } from '@jiwar/i18n';
import type en from '../en/fin-spending-reports.ts';

const ar: Translation<typeof en> = {
  title: 'أين ذهبت الرسوم',
  description: 'ما يطّلع عليه السكان من الميزانية: مخصص كل فئة وما أُنفق منها، وما دفعته الرسوم.',
  publish: 'انشر تقريرًا',
  empty: 'لم يُنشر شيء بعد',
  year: 'السنة',
  residents: 'السكان',
  superseded: 'حلّ محله تقرير أحدث',
  reading: 'يقرؤونه',
  asOf: 'حتى تاريخ',
  spent: 'المنصرف',
  spentLine: '{spent} من {allowance} ({pct})',
  improvements: 'التحسينات',
  published: 'تاريخ النشر',
  supersede: 'استبدل',
  detailTitle: '{year}، حتى {asOf}',
  detailSuperseded: '{year}، حتى {asOf} (حلّ محله تقرير أحدث)',
  noCategory: 'لا توجد فئات',
  category: 'الفئة',
  allowed: 'المخصص',
  used: 'المستخدم',
  'publish.title': 'نشر أين ذهبت الرسوم',
  'publish.supersedeTitle': 'استبدال تقرير {year} حتى {asOf}',
  'publish.description':
    'أرقام الميزانية حسب الفئة حتى اليوم، وتُجمَّد بعد النشر، مع التحسينات التي دفعتها الرسوم بكلماتك. لا يظهر فيها مصروف بعينه ولا مورد ولا اسم.',
  'publish.supersedeDescription':
    'التقرير المنشور لا يتغير: هذا التقرير الأحدث لنفس الميزانية حتى اليوم يحل محله أمام السكان، ويبقى السابق متاحًا هنا.',
  'publish.confirm': 'انشر',
  'publish.done': 'تم النشر: يُبلَّغ كل من يدفع رسوم وحدة، ومنهم المستأجرون.',
  'publish.supersededDone': 'تم النشر: يقرأ السكان هذا التقرير وحده الآن، ويبقى التقرير السابق هنا.',
  budget: 'الميزانية',
  budgetHint: 'إذا تُرك فارغًا فهي ميزانية السنة الجارية.',
  yearUnderWay: 'السنة الجارية',
  summaryEn: 'الملخص بالإنجليزية',
  summaryHint: 'باللغتين معًا، أو بدونهما.',
  summaryBoth: 'اكتبه باللغتين معًا، أو اتركهما فارغين.',
  summaryAr: 'الملخص بالعربية',
  improvement: 'التحسين {n}، بالإنجليزية',
  inArabic: 'بالعربية',
  decision: 'قرار مجلس الإدارة الذي نفّذه',
  addImprovement: 'أضف تحسينًا',
};

export default ar;
