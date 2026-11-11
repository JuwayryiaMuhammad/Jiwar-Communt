import type { Translation } from '@jiwar/i18n';
import type en from '../en/ops-vendor-contractors.ts';

const ar: Translation<typeof en> = {
  title: 'المقاولون',
  description: 'الأشخاص الذين يسجّلون الدخول باسم هذه الشركة: يقبلون البلاغات التي تعرضها الإدارة عليها ويقدّمون العطاءات على مناقصاتها.',
  invite: 'ادعُ مقاولًا',
  suspendedHint: 'المورد الموقوف لا يقبل مقاولين.',
  inviteTitle: 'دعوة مقاول من {vendor}',
  inviteDescription: 'يسجّل دخوله كما يفعل الموظفون، برمز يصله على بريده. تُحفظ هويته كأي حساب.',
  invited: 'دُعي {name} مقاولًا من {vendor}.',
  contractor: 'المقاول',
  none: 'لا يوجد مقاول بعد',
  erased: 'حساب ممسوح',
  contact: 'بيانات التواصل',
  since: 'منذ',
  deactivate: 'إيقاف',
  activate: 'تفعيل',
  canSignIn: 'يستطيع {name} تسجيل الدخول من جديد.',
  cannotSignIn: 'لم يعد {name} يستطيع تسجيل الدخول.',
  deactivateTitle: 'هل تريد إيقاف {name}؟',
  activateTitle: 'هل تريد تفعيل {name}؟',
  deactivateDescription: 'لا يستطيع تسجيل الدخول، وتعود البلاغات التي بين يديه إلى الإدارة.',
  activateDescription: 'يستطيع تسجيل الدخول من جديد مقاولًا من هذا المورد.',
};

export default ar;
