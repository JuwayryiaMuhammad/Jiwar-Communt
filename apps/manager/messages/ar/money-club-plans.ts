import type { Translation } from '@jiwar/i18n';
import type en from '../en/money-club-plans.ts';

const ar: Translation<typeof en> = {
  title: 'باقات النادي',
  description: 'ما تشتريه الدفعة في المكتب: مدة من الباقة. يرى السكان الباقات النشطة وأسعارها.',
  newPlan: 'باقة جديدة',
  empty: 'لا توجد باقات بعد',
  'col.plan': 'الباقة',
  'col.duration': 'المدة',
  'col.price': 'السعر',
  retired: 'موقوفة',
  retire: 'أوقف',
  restore: 'أعد تفعيلها',
  offeredAgain: 'عادت {name} متاحة.',
  retiredToast: 'أُوقفت {name}.',
  editTitle: 'تعديل {name}',
  dialogDescription: 'تحدد الباقة المدة التي تُبقي فيها الدفعةُ الاشتراكَ نشطًا. يظهر سعرها، أما المبلغ المدفوع فهو ما يسجله المحاسب.',
  saved: 'تم حفظ {name}.',
  nameEn: 'الاسم بالإنجليزية',
  nameAr: 'الاسم بالعربية',
  duration: 'المدة',
  durationHint: 'لا تتغير بعد الإنشاء.',
  'option.custom': 'عدد من الأيام',
  days: 'الأيام',
  daysRange: 'من 1 إلى 730.',
  price: 'السعر (ج.م)',
  moneyInvalid: 'أكبر من صفر، وبحد أقصى رقمين عشريين.',
};

export default ar;
