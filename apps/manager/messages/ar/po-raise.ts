import type { Translation } from '@jiwar/i18n';
import type en from '../en/po-raise.ts';

const ar: Translation<typeof en> = {
  title: 'إصدار أمر شراء',
  description: 'مباشرة، أو من طلب شراء معتمد، أو من مناقصة تمت ترسيتها. يعتمده شخص غير الذي أصدره، ويحجز بند الميزانية مبلغه من وقتها.',
  fromRequest: 'من طلب الشراء {reference}: {title}',
  fromTender: 'من المناقصة {reference}: {title}',
  sourceGone: 'تعذّرت قراءة المصدر هنا. يُصدر الأمر منه مع ذلك: ينطبق مورده وبند ميزانيته ما لم تختر غيرهما.',
  vendor: 'المورد',
  chooseVendor: 'اختر موردًا',
  vendorFromAward: 'المورد الذي رُسيت عليه المناقصة',
  vendorFromSource: 'مورد الطلب',
  vendorNoAccess: 'سجل الموردين يظهر للأدوار التي تتولاه: أصدر الأمر من طلب شراء أو مناقصة، أو اطلب هذه الصلاحية.',
  budgetFromRequest: 'يُدفع من بند الميزانية المذكور في الطلب.',
  budgetFromTender: 'يُدفع من بند الميزانية المذكور في المناقصة.',
  deliveryOn: 'يوم التسليم',
  deliveryHint: 'ليس قبل اليوم.',
  note: 'ملاحظة',
  noteHint: 'للمعتمِد ولنسخة المورد.',
  linesTitle: 'المطلوب شراؤه',
  linesHint: 'الكميات حتى ثلاث خانات عشرية، والأسعار بالقرش. بند المخزون يُستلم في مخزن، وبند الخدمة يُؤكَّد تنفيذه.',
  submit: 'أصدر الأمر',
  raised: 'صدر برقم {reference}: يعتمده شخص آخر.',
  cancel: 'العودة إلى الأوامر',
};

export default ar;
