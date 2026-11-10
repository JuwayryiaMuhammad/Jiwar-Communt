import type { Translation } from '@jiwar/i18n';
import type en from '../en/guard-common.ts';

const ar: Translation<typeof en> = {
  erased: 'حساب محذوف',
  overnight: '{window} (يمتد لليوم التالي)',
  minutes: '{m} د',
  hours: '{h} س',
  hoursMinutes: '{h} س {m} د',
  unscheduled: 'بلا جدول',
  everyDay: 'كل يوم',
  patrolSchedule: '{days} في {times}',
  everyGate: 'كل البوابات',
  aGate: 'بوابة',
  lockdownBanner: 'الإغلاق الأمني سارٍ: {gates}',
  purgedPerson: 'شخص (حُذفت بياناته)',
  'picker.post': 'اختر موقعًا…',
  'picker.loadingPosts': 'جارٍ تحميل المواقع…',
  'picker.gates': 'البوابات',
  'picker.zones': 'المناطق',
  'picker.guard': 'اختر حارسًا…',
  'picker.loadingGuards': 'جارٍ تحميل الحراس…',
};

export default ar;
