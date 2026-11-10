import type { Translation } from '@jiwar/i18n';
import type en from '../en/gate-access.ts';

const ar: Translation<typeof en> = {
  title: 'مراجعة الصلاحيات',
  description: 'حسابات الموظفين والمديرين والمقاولين التي تبدو غير مستخدمة، والمراجعة الدورية لمن لديه صلاحية الدخول.',
  dangling: 'حسابات غير مستخدمة',
  danglingEmpty: 'لا يوجد حساب يبدو غير مستخدم',
  erased: 'محذوف',
  'col.account': 'الحساب',
  'col.why': 'السبب',
  'col.lastSignIn': 'آخر تسجيل دخول',
  'col.found': 'تاريخ الرصد',
  never: 'لم يدخل قط',
  keepAria: 'إبقاء الحساب مع ذكر السبب',
  keepPlaceholder: 'إبقاء…',
  deactivate: 'إيقاف الحساب',
  kept: 'تم الإبقاء عليه، ولن يُرصد مرة أخرى قبل 90 يومًا.',
  deactivated: 'تم إيقاف الحساب.',
  review: 'مراجعة الصلاحيات',
  reviewNumbered: 'مراجعة الصلاحيات {number}',
  reviewIntro: 'فُتحت {when}: يلزم البتّ في {undecided} من {lines} بندًا. سحب الصلاحية يوقف الحساب فورًا.',
  openReview: 'افتح مراجعة الآن',
  reviewOpened: 'تم فتح المراجعة.',
  reviewEmpty: 'لا يوجد من يُراجَع',
  'col.role': 'الدور',
  'col.permissions': 'الصلاحيات',
  'col.decision': 'القرار',
  someoneElse: 'يقرر شخص آخر',
  keep: 'إبقاء',
  revoke: 'سحب الصلاحية',
  settings: 'الإعدادات',
  idleDays: 'أيام الخمول ({min}–{max})',
  reviewEvery: 'مراجعة كل (أيام، {min}–{max})',
};

export default ar;
