import type { Translation } from '@jiwar/i18n';
import type en from '../en/auth.ts';

const ar: Translation<typeof en> = {
  // Sign-in.
  'login.title': 'تسجيل الدخول إلى المنصة',
  'login.subtitle': 'لمسؤولي منصة جوار.',
  'login.password': 'كلمة المرور',
  'login.submit': 'سجّل الدخول',
  'login.bandTitle': 'كل المجمعات في لوحة واحدة.',
  'login.bandBody': 'افتح المجمعات، وعيّن مديريها، وراقب أمان تسجيل الدخول على المنصة كلها.',
  'login.point.compounds': 'المجمعات ومديروها',
  'login.point.events': 'أحداث الأمان في كل المجمعات',
  'login.point.audit': 'سجل تدقيق المنصة، لا يُعدَّل',
  // The forced password change.
  'change.title': 'عيّن كلمة مرور جديدة',
  'change.body': 'عُيّنت كلمة المرور هذه عند الإعداد. اختر كلمة مرور خاصة بك قبل المتابعة.',
  'change.alert': 'تغييرها يُنهي كل جلسات المنصة الأخرى.',
  'change.submit': 'احفظ وتابع',
  'change.back': 'العودة إلى تسجيل الدخول',
  'change.bandTitle': 'خطوة أخيرة.',
  'change.bandBody': 'تتوقف كلمة مرور الإعداد عن العمل بمجرد حفظ كلمة مرور جديدة.',
  // The password form.
  'form.current': 'كلمة المرور الحالية',
  'form.new': 'كلمة المرور الجديدة',
  'form.minLength':
    '{n, plural, one {حرف واحد على الأقل.} two {حرفان على الأقل.} few {# أحرف على الأقل.} many {# حرفًا على الأقل.} other {# حرف على الأقل.}}',
  'form.repeat': 'أعد كتابة كلمة المرور الجديدة',
  'form.mismatch': 'غير متطابقة.',
  // The account page.
  'account.title': 'الحساب',
  'account.description': 'بيانات دخولك كمسؤول للمنصة.',
  'account.changeTitle': 'تغيير كلمة المرور',
  'account.changeSubmit': 'غيّر كلمة المرور',
  'account.alert': 'الحفظ يُنهي كل جلسات المنصة الأخرى، وتبقى هذه الجلسة مفتوحة.',
  'account.changed': 'تم تغيير كلمة المرور.',
  'account.lockoutTitle': 'قفل الحساب',
  'account.lockoutBody': 'تكرار كلمة المرور الخاطئة يقفل الحساب لفترة، وتُسجَّل كل محاولة في أحداث الأمان.',
};

export default ar;
