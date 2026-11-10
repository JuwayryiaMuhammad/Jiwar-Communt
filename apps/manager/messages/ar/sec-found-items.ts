import type { Translation } from '@jiwar/i18n';
import type en from '../en/sec-found-items.ts';

const ar: Translation<typeof en> = {
  title: 'المعثورات عند البوابة',
  descriptionBefore: 'ما سجّله الأمن. لعرض غرض على السكان، انشره على ',
  board: 'لوحة المفقودات والمعثورات',
  register: 'تسجيل',
  registered: 'تم التسجيل في المكتب.',
  registerTitle: 'تسجيل غرض عُثر عليه',
  registerDescription: 'في المكتب. يسجّل الحراس ما يجدونه عند البوابة من التطبيق.',
  what: 'ما هو',
  whereFound: 'مكان العثور عليه',
  claimed: 'تم تسجيل الاستلام.',
  claimTitle: 'تسجيل مطالبة المالك',
  claimDescription: 'وحدة أو اسم، كما ذكرهما صاحب الغرض. يُحفظ الاسم 30 يومًا، كاسم الزائر.',
  recordClaim: 'تسجيل المطالبة',
  unitCode: 'كود الوحدة',
  received: 'تم الاستلام من البوابة.',
  shown: 'الأغراض المعروضة',
  'view.at_gate': 'عند البوابة',
  'view.with_management': 'في المكتب',
  'view.claimed': 'تم استلامها',
  empty: 'لا يوجد شيء هنا',
  'col.what': 'ما هو',
  'col.where': 'المكان',
  'col.found': 'وقت العثور',
  'col.by': 'سجّله',
  receivedButton: 'تم الاستلام',
  claimedButton: 'استلمها صاحبها',
};

export default ar;
