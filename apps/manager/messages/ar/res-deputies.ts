import type { Translation } from '@jiwar/i18n';
import type en from '../en/res-deputies.ts';

const ar: Translation<typeof en> = {
  title: 'النائب',
  description:
    'شخص يقرر بدلًا منك لمدة تصل إلى 30 يومًا. يملك ما تمنحه إياه وتفقده أنت حتى تنتهي المدة، ويُسجَّل ما يفعله على أنه نيابة عنك.',
  named: 'تمت التسمية. أُبلغ نائبك.',
  ended: 'انتهت النيابة. أُبلغ الطرف الآخر.',
  none: 'لا يوجد نائب',
  'col.side': 'أنت',
  'col.permissions': 'الصلاحيات',
  'col.until': 'حتى',
  away: 'غائب',
  theDeputy: 'النائب',
  inForce: 'سارية',
  endNow: 'أنهِ الآن',
  'reason.ended': 'انتهت قبل موعدها',
  'reason.expired': 'انتهت مدتها',
  'reason.account_left': 'أحدكما لم يعد نشطًا',
  'reason.other': 'انتهت',
  nameTitle: 'تسمية نائب',
  deputy: 'النائب',
  chooseAccount: 'اختر حسابًا',
  until: 'حتى',
  untilHint: 'بحد أقصى 30 يومًا من الآن.',
  decides: 'ما يقرره بدلًا منك',
  nameButton: 'سمِّ النائب',
};

export default ar;
