import type { Translation } from '@jiwar/i18n';
import type en from '../en/maint-work-order.ts';

const ar: Translation<typeof en> = {
  title: 'أمر عمل جديد',
  descriptionAlert: 'لهذه القفزة في الاستهلاك: يُسجَّل استلام التنبيه معه. إن لم تحدد مكانًا، فأصل العداد أو منطقته.',
  description: 'عمل يخص المجمع نفسه، على أصل أو منطقة مشتركة. يوزَّع مثل أي إصلاح.',
  open: 'افتح أمر العمل',
  on: 'على',
  'place.asset': 'أصل',
  'place.area': 'منطقة مشتركة',
  asset: 'الأصل',
  theMeters: 'الخاص بالعداد',
  chooseAsset: 'اختر أصلًا',
  commonArea: 'المنطقة المشتركة',
  chooseArea: 'اختر منطقة',
  category: 'الفئة',
  chooseCategory: 'اختر فئة',
  priority: 'الأولوية',
  priorityHint: 'أولوية الفئة إن تُركت فارغة.',
  categorys: 'أولوية الفئة',
  whatToDo: 'المطلوب عمله',
  workOrder: 'أمر العمل',
  accept: 'اقبل العمل',
  sendBack: 'أعِده للفني',
  'origin.plan': 'فتحته خطة صيانة.',
  'origin.inspection': 'فتحته ملاحظة من فحص.',
  'origin.field': 'أبلغ عنه فني في الموقع.',
  'origin.staff': 'فتحته الإدارة.',
  openAsset: 'افتح الأصل',
  closed: 'أُغلق {number}.',
  sentBack: 'أُعيد {number} إلى الفني.',
  sendBackTitle: 'أعِد العمل',
  sendBackDescription: 'يقرأ الفني السبب في محادثة البلاغ.',
  forTechnician: 'للفني',
  postedInThread: 'يُنشر في محادثة البلاغ.',
};

export default ar;
