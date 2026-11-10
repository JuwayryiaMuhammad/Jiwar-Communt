import type { Translation } from '@jiwar/i18n';
import type en from '../en/money-club.ts';

const ar: Translation<typeof en> = {
  'duration.monthly': 'شهري',
  'duration.quarterly': 'ربع سنوي',
  'duration.annual': 'سنوي',
  'duration.custom': 'مخصص',
  durationDays: '{n, plural, =0 {لا أيام} one {يوم واحد} two {يومان} few {# أيام} many {# يومًا} other {# يوم}}',
  'paidOn.pickDay': 'اختر يومًا.',
  'paidOn.future': 'لا يمكن أن يكون في المستقبل.',
  'paidOn.tooOld': 'خلال 90 يومًا على الأكثر.',
  'people.none': 'لا يسكن أحد في هذه الوحدة الآن.',
  'people.erased': 'محذوف',
  'people.minor': 'قاصر',
  'people.occupancy': 'ساكن',
  'people.member': 'فرد من الأسرة',
};

export default ar;
