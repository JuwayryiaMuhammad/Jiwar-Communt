import type { Translation } from '@jiwar/i18n';
import type en from '../en/maint-new-ticket.ts';

const ar: Translation<typeof en> = {
  resident: 'ساكن',
  title: 'بلاغ صيانة جديد لساكن',
  description: 'لساكن طلب حضوريًا أو بالهاتف. يُبلَّغ بأن بلاغًا فُتح باسمه.',
  open: 'افتح البلاغ',
  where: 'المكان',
  'place.unit': 'في وحدة',
  'place.common': 'منطقة مشتركة',
  unit: 'الوحدة',
  room: 'الغرفة',
  roomHint: 'اختياري.',
  notGiven: 'غير محددة',
  commonArea: 'المنطقة المشتركة',
  commonAreaHint: 'أين بالضبط: الصالة الرياضية، البوابة الشمالية، حمام السباحة.',
  reportedBy: 'مقدّم البلاغ',
  reportersFailed: 'تعذّر تحميل أفراد هذه الوحدة.',
  reportersNone: 'لا يحق لأحد في هذه الوحدة فتح بلاغ فيها.',
  reportersUnit: 'المقيمون فيها وأفراد الأسرة المسموح لهم بفتح البلاغات.',
  reportersCommon: 'ساكن في المجمع: اكتب جزءًا من الاسم، أو الهاتف أو البريد الإلكتروني كاملًا.',
  pickUnitFirst: 'اختر وحدة أولًا',
  selectResident: 'اختر ساكنًا…',
  category: 'الفئة',
  priority: 'الأولوية',
  priorityHintOf: 'إن تُركت فارغة: أولوية الفئة ({priority}).',
  priorityHint: 'إن تُركت فارغة: أولوية الفئة.',
  categoryDefault: 'أولوية الفئة',
  whatIsWrong: 'ما المشكلة',
};

export default ar;
