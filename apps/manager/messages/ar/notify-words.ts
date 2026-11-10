import type { Translation } from '@jiwar/i18n';
import type en from '../en/notify-words.ts';

const ar: Translation<typeof en> = {
  'device.ios': 'آيفون أو آيباد',
  'device.android': 'هاتف أندرويد',
  'device.desktop_web': 'متصفح كمبيوتر',
  'device.mobile_web': 'متصفح هاتف',
  'device.other': 'جهاز',
  'post.lost': 'غرض مفقود',
  'post.found': 'غرض معثور عليه',
  'post.lend': 'عرض إعارة',
  'post.borrow': 'طلب استعارة',
  'post.other': 'منشور',
  'exception.worker_outside_hours': 'عامل خارج مواعيده',
  'exception.visitor_without_pass': 'زائر بدون تصريح',
  'exception.unregistered_vehicle': 'مركبة غير مسجلة',
  'exception.other': 'شخص',
};

export default ar;
