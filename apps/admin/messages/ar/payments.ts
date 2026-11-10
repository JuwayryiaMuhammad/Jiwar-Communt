import type { Translation } from '@jiwar/i18n';
import type en from '../en/payments.ts';

const ar: Translation<typeof en> = {
  // The step-up dialog.
  'stepUp.resend': 'أرسل رمزًا جديدًا',
  'stepUp.code': 'رمز التحقق',
  'stepUp.sent': 'ستة أرقام أُرسلت إلى بريدك الإلكتروني، صالحة لبضع دقائق.',
  'stepUp.sending': 'جارٍ إرسال رمز إلى بريدك الإلكتروني…',
  // The card.
  'card.title': 'الدفع الإلكتروني',
  'card.replace': 'استبدل بيانات الاعتماد',
  'card.set': 'أدخل بيانات الاعتماد',
  'card.allow': 'اسمح مجددًا',
  'card.switchOff': 'أوقف',
  'card.available': 'يستطيع السكان الدفع إلكترونيًا',
  'card.managersSwitch': 'اختيار مديري المجمع',
  'card.on': 'مُفعّل',
  'card.off': 'متوقف',
  'card.platform': 'المنصة',
  'card.switchedOff': 'موقوف',
  'card.allowed': 'مسموح',
  'card.integrations': 'التكاملات',
  'card.integrationsValue': 'البطاقة {card} · المحفظة {wallet}',
  'card.lastSet': 'آخر تعيين',
  'card.lastSetValue': '{when} · بواسطة {who, select, platform {المنصة} other {مدير المجمع}}',
  'card.switchedOffToast': 'أُوقف الدفع الإلكتروني لهذا المجمع.',
  'card.allowedToast': 'عاد القرار إلى مديري المجمع.',
  'switch.offTitle': 'أوقف الدفع الإلكتروني',
  'switch.onTitle': 'أعد القرار إلى مديري المجمع',
  'switch.description': 'أكّد برمز تأكيد جديد يُرسل إلى بريدك الإلكتروني. الدفعات التي تمت بالفعل تُسجَّل كالمعتاد.',
  // The fields.
  mode: 'الوضع',
  'mode.sandbox': 'وضع التجربة (test)',
  'mode.live': 'الوضع الفعلي',
  secretKey: 'المفتاح السري',
  publicKey: 'المفتاح العام',
  hmacSecret: 'سر HMAC',
  // The credentials' dialog.
  'creds.title': 'بيانات اعتماد بوابة الدفع Paymob للمجمع',
  'creds.description':
    'من حساب Paymob الخاص بالمجمع؛ تُستبدل كلها معًا وتُخزَّن مشفّرة. ويرى مديرو المجمع من أدخلها آخر مرة.',
  'creds.card': 'معرّف تكامل البطاقات',
  'creds.wallet': 'معرّف تكامل المحفظة الإلكترونية',
  'creds.walletHint': 'اتركه فارغًا للدفع بالبطاقة فقط.',
  'creds.saved': 'تم الحفظ. لا يظهر منها إلا آخر أربعة أحرف.',
  'creds.confirmTitle': 'أكّد هويتك',
  'creds.confirmDescription': 'لا تتغير بيانات الدفع لأي مجمع إلا بعد رمز تأكيد جديد يُرسل إلى بريدك الإلكتروني.',
  'key.prefix': 'يبدأ بـ {test} أو {live}.',
  'key.live': 'الوضع الفعلي يتطلب مفتاح live.',
  'key.test': 'وضع التجربة يتطلب مفتاح test.',
};

export default ar;
