import type { Translation } from '@jiwar/i18n';
import type en from '../en/sec-child-alerts.ts';

const ar: Translation<typeof en> = {
  title: 'تنبيهات الأطفال',
  description: 'حاول شخص اصطحاب طفل لا يجوز أن يذهب معه. يُبلَّغ أهل الوحدة والمسؤولون فورًا، وتُحفظ التنبيهات 30 يومًا.',
  empty: 'لا توجد محاولة استلام غير مصرح بها في آخر 30 يومًا',
  detailTitle: 'استلام غير مصرح به',
  erasedAccount: 'حساب محذوف',
  'method.resident_qr': 'رمز QR لدخول الساكن',
  'method.worker_qr': 'بطاقة العامل',
  'method.worker_code': 'كود العامل',
  'method.pickup_qr': 'رمز QR للاستلام',
  'method.pickup_code': 'كود الاستلام',
  'method.alone': 'بمفرده',
  'method.unidentified': 'لم تُعرف هويته',
  escort: 'مرافق: {kind}',
  'col.when': 'الوقت',
  'col.post': 'الموقع',
  'col.unit': 'الوحدة',
  'col.how': 'كيف',
  'col.why': 'السبب',
  'col.guard': 'الحارس',
  howKnown: 'كيف عُرف الشخص',
  whyRefused: 'سبب الرفض',
};

export default ar;
