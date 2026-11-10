import type { Translation } from '@jiwar/i18n';
import type en from '../en/deletions.ts';

const ar: Translation<typeof en> = {
  title: 'طلبات الحذف',
  description:
    'حسابات طلب أصحابها حذفها. بعد فترة تهدئة مدتها 14 يومًا يحذف النظام الحساب تلقائيًا؛ أما الحساب الذي يعطّله شيء فينتظر هنا قرارك.',
  thisPerson: 'هذا الشخص',
  closedToast: 'أُغلق الطلب. ويبقى الحساب كما هو.',
  empty: 'لا يوجد طلب حذف مفتوح',
  emptyHint: 'يطلب الساكن من التطبيق، أو تطلب الإدارة نيابة عنه من صفحة حسابه.',
  account: 'الحساب',
  waiting: 'ينتظر قرارك',
  due: 'مستحق: سيحذفه النظام قريبًا',
  coolingOff: 'في فترة التهدئة',
  coolingEnds: 'تنتهي التهدئة',
  askedOn: 'طُلب في {when}',
  daysAgo: '{days, plural, =0 {اليوم} one {منذ يوم} two {منذ يومين} few {منذ # أيام} many {منذ # يومًا} other {منذ # يوم}}',
  askedBy: 'طلبه',
  byManagement: 'الإدارة، نيابة عنه',
  byPerson: 'الشخص نفسه',
  blocks: 'ما الذي يمنعه',
  nothingKnown: 'لا شيء معروف',
  erase: 'احذف…',
  closeRequest: 'أغلق الطلب',
  closeTitle: 'هل تريد إغلاق طلب حذف {name}؟',
  closeDescription: 'لن يُحذف الحساب ويظل يعمل. يُبلَّغ الشخص ويمكنه الطلب مرة أخرى لاحقًا.',
};

export default ar;
