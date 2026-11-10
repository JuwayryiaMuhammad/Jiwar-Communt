import type { Translation } from '@jiwar/i18n';
import type en from '../en/shell-login.ts';

const ar: Translation<typeof en> = {
  'title.signIn': 'تسجيل دخول الإدارة',
  'title.account': 'اختر المجمع',
  'title.denied': 'لا تملك صلاحية الدخول',
  'intro.identifier': 'أدخل بريدك الإلكتروني أو هاتفك. سنرسل إلى بريدك رمز تحقق من 6 أرقام.',
  'intro.code': 'ابحث عن الرمز في بريدك الإلكتروني. تنتهي صلاحيته خلال دقائق.',
  'intro.account': 'لديك أكثر من حساب. اختر واحدًا لهذه الجلسة.',
  'intro.denied':
    'هذا الحساب لا يملك صلاحية دخول لوحة الإدارة. اللوحة لمديري المجمعات ومشرفي الصيانة، وغيرهم يستخدم تطبيق جوار.',
  identifier: 'البريد الإلكتروني أو الهاتف',
  sendCode: 'أرسل الرمز',
  code: 'رمز التحقق',
  sentFor: 'أُرسل إلى {identifier}',
  verify: 'تحقق',
  changeIdentifier: 'غيّر البريد أو الهاتف',
  resend: 'أرسل رمزًا جديدًا',
  deniedHint: 'إن كان هذا خطأ، فاطلب من مدير مجمعك مراجعة دورك.',
  anotherAccount: 'سجّل الدخول بحساب آخر',
  noEligible: 'لا يوجد بين حساباتك حساب مدير أو موظف. يستخدم السكان تطبيق جوار.',
  'role.manager': 'مدير',
  'role.staff': 'موظف',
  useApp: '{type} · استخدم التطبيق',
  startOver: 'ابدأ من جديد',
  product: 'جوار للإدارة',
  tagline: 'مجمعك في مكان واحد.',
  lede: 'السكان والأسر والموظفون والعمالة والبوابة، وكل قرار مسجّل.',
  'point.residents': 'السكان والأسر والطلبات',
  'point.gates': 'البوابات وسجل الدخول',
  'point.roles': 'الأدوار والإعدادات وسجل التدقيق',
};

export default ar;
