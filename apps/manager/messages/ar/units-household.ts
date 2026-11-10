import type { Translation } from '@jiwar/i18n';
import type en from '../en/units-household.ts';

const ar: Translation<typeof en> = {
  thisMember: 'هذا الفرد',
  removed: 'أُزيل {name} من الأسرة.',
  revoked: 'سُحبت الصلاحية من {name}.',
  holdsNothing: 'لا يملك {name} أي صلاحية في هذه الأسرة.',
  revokeAccess: 'اسحب صلاحية',
  removeTitle: 'إزالة {name} من الأسرة؟',
  removeDescription: 'يفقد مكانه في أسرة هذه الوحدة وكل ما كان يتيحه له ذلك. يُبلَّغ بذلك مع رسالتك. ويمكن للساكن الرئيسي دعوته من جديد.',
  removeConfirm: 'أزل الفرد',
  revokeTitle: 'سحب صلاحية من {name}؟',
  revokeKnown: 'يبقى في الأسرة ويفقد ما تختاره مما يملكه الآن. يُبلَّغ بذلك مع رسالتك.',
  revokeUnknown: 'يبقى في الأسرة ويفقد ما تختاره. يُبلَّغ بذلك مع رسالتك. دورك لا يعرض ما يملكه، لذا يُرفض سحب أي صلاحية لا يملكها.',
  revokeConfirm: 'اسحب',
  whatToTakeBack: 'ما تريد سحبه',
  'perm.visitors_invite': 'دعوة الزوار',
  'perm.bookings': 'الحجوزات',
  'perm.tickets': 'بلاغات الصيانة',
  'perm.finance': 'المدفوعات',
  'perm.unit_security': 'أمن الوحدة',
  'perm.polls_vote': 'التصويت في الاستطلاعات',
  'perm.all': 'كل ما مُنح له',
  thisResident: 'هذا الساكن',
  nowOwnsToast: 'أصبح {name} مالك الوحدة.',
  livesInToast: 'أصبح {name} يسكن في الوحدة.',
  landlordToast: 'أصبح {name} مالكًا لا يسكن في الوحدة.',
  nowOwns: 'أصبح مالكًا',
  movedOut: 'غادر الوحدة',
  movedIn: 'انتقل إلى الوحدة',
  convertTitle: 'هل اشترى {name} الوحدة؟',
  convertDescription:
    'تنتهي إقامته كمستأجر وتبدأ مكانها إقامة كمالك، ويبقى الساكن الرئيسي إن كان كذلك. يُبلَّغ بذلك، وتُتاح له قرارات المالك.',
  makeOwner: 'اجعله مالكًا',
  livesThere: 'يسكن في الوحدة',
  moveOutTitle: 'هل غادر {name} الوحدة؟',
  moveInTitle: 'هل انتقل {name} إلى الوحدة؟',
  moveOutDescription:
    'يبقى مالكًا لكنه لا يسكن فيها: لا يعود يرى الأسرة التي تسكنها. يجب أن يسكن الساكن الرئيسي في الوحدة، فعيّن ساكنًا رئيسيًا آخر أولًا.',
  moveInDescription: 'يصبح مالكًا يسكن في الوحدة، ويمكن تعيينه ساكنها الرئيسي.',
  recordMoveOut: 'سجّل المغادرة',
  recordMoveIn: 'سجّل الانتقال',
};

export default ar;
