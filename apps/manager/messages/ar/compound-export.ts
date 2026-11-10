import type { Translation } from '@jiwar/i18n';
import type en from '../en/compound-export.ts';

const ar: Translation<typeof en> = {
  title: 'تصدير بيانات المجمع',
  description:
    'بيانات التشغيل في المجمع في أرشيف واحد بجداول ثابتة. بلا أسماء أو هواتف أو بريد إلكتروني أو نصوص أشخاص؛ فبيانات الشخص نفسه لا تخرج إلا بتصديره هو لها.',
  export: 'صدّر بيانات المجمع',
  asked: 'تم الطلب. سيصلك إشعار في التطبيق عندما يجهز.',
  empty: 'لا يوجد تصدير بعد',
  askedOn: 'وقت الطلب',
  rows: 'الصفوف',
  confirmTitle: 'تأكيد أنك أنت',
  confirmDescription:
    'تخرج بيانات المجمع كلها مع هذا التصدير: ولا يُجهَّز إلا بعد رمز جديد يصلك على بريدك الإلكتروني.',
};

export default ar;
