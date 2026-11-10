import type { Translation } from '@jiwar/i18n';
import type en from '../en/accounts-me.ts';

const ar: Translation<typeof en> = {
  title: 'حسابي',
  description: 'تسجيل دخولك ولغتك وإعدادات الإشعارات الخاصة بك.',
  yourAccount: 'حسابك',
  role: 'الدور',
  'locale.en': 'الإنجليزية (English)',
  'locale.ar': 'العربية',
  'language.title': 'اللغة',
  'language.label': 'لغة ما يصلك من رسائل',
  'language.hint': 'الرسائل والإشعارات التي تصلك من الكمبوند. أما لغة لوحة التحكم نفسها فتُغيَّر من القائمة.',
  'language.saved': 'تم حفظ اللغة.',
  'language.save': 'احفظ اللغة',
  'notify.title': 'إعدادات الإشعارات',
  'notify.intro':
    'ما يصلك أيضًا عبر البريد الإلكتروني. تبقى كل الإشعارات في قائمتك مهما كانت الإعدادات، وتصلك دائمًا إشعارات الطوارئ والأمان.',
  'notify.saved': 'تم حفظ إعدادات الإشعارات.',
  'notify.discard': 'تجاهل',
  'notify.save': 'احفظ الإعدادات',
  'sessions.title': 'الأجهزة المسجَّل دخولك منها',
  'sessions.signOutAll': 'اخرج من كل الأجهزة',
  'sessions.empty': 'لا توجد جلسات',
  'sessions.device': 'الجهاز',
  'sessions.current': 'هذه الجلسة',
  'sessions.signedIn': 'وقت الدخول',
  'sessions.lastUsed': 'آخر استخدام',
  'sessions.signOut': 'خروج',
  'sessions.signedOut': 'تم إنهاء تلك الجلسة.',
  'sessions.endTitle': 'إنهاء هذه الجلسة؟',
  'sessions.endDescription': '{device}، دخل في {when}. سيحتاج إلى تسجيل الدخول من جديد برمز.',
  'sessions.endAllTitle': 'الخروج من كل الأجهزة؟',
  'sessions.endAllDescription':
    'تنتهي كل جلسات حسابك، ومنها هذه الجلسة، على كل الأجهزة. استخدم هذا إذا كانت هناك جلسة ليست لك. ستسجّل الدخول من جديد برمز.',
  'device.on': '{browser} على {system}',
  'device.app': 'تطبيق الموبايل',
  'device.unknown': 'جهاز غير معروف',
};

export default ar;
