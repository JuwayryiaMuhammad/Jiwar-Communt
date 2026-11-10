import type { Translation } from '@jiwar/i18n';
import type en from '../en/guard-offline.ts';

const ar: Translation<typeof en> = {
  'flag.lockdown_entered': 'سُمح بالدخول أثناء إغلاق أمني للبوابة',
  'flag.blocklist_ban_entered': 'سُمح بدخول لوحة محظورة',
  'flag.credential_banned': 'سُمح بدخول عامل محظور، أو عامل تصريح موقوف',
  'flag.once_only_reused': 'استُخدم تصريح المرة الواحدة مرة أخرى',
  'flag.action_rejected': 'إجراء لا يمكن أن يكون قد حدث',
  'flag.device_revoked_upload': 'جهاز ملغى أرسل بيانات: عُزلت',
  'flag.contractor_unresolved': 'مقاول لا يطابق أي عامل في التصريح',
  'flag.child_exit_unverified': 'خروج طفل مع مرافق لم يُتحقق منه',
  'flag.credential_revoked': 'تصريح أو بطاقة لم تعد صالحة وقتها',
  'flag.invalid_at_time': 'خارج مدة الصلاحية أو المواعيد',
  'flag.capacity_exceeded': 'عدد بالداخل أكبر مما يسمح به التصريح',
  'flag.clock_skew': 'ساعة الجهاز لم تكن مضبوطة',
  'flag.bundle_expired': 'حُسم ببيانات منتهية الصلاحية',
  'flag.shift_ended': 'بعد انتهاء الوردية',
  'flag.patrol_scan_refused': 'مسح دورية رفضته الجولة',
  'flag.blocklist_watch_entered': 'سُمح بدخول لوحة تحت المراقبة',
  'flag.already_inside': 'سُجل دخوله وهو بالداخل بالفعل',
  'flag.exit_without_entry': 'خروج دون أحد بالداخل',
  'flag.duplicate_inside': 'مركبة خدمة سُجل دخولها مرتين',
  skewEarly: 'مبكرًا {s} ث',
  skewLate: 'متأخرًا {s} ث',
  clockBehind: 'الساعة متأخرة {s} ث',
  clockAhead: 'الساعة متقدمة {s} ث',
  matching: '{n} مطابق',
  'device.revoked': 'ملغى',
  'device.quiet': 'بلا اتصال منذ {n} د',
  'device.missing':
    '{n, plural, one {إجراء واحد ناقص} two {إجراءان ناقصان} few {# إجراءات ناقصة} many {# إجراءً ناقصًا} other {# إجراء ناقص}}',
  'device.flags':
    '{n, plural, one {تنبيه واحد للمراجعة} two {تنبيهان للمراجعة} few {# تنبيهات للمراجعة} many {# تنبيهًا للمراجعة} other {# تنبيه للمراجعة}}',
  'device.onShift': 'في الوردية، يتزامن',
  'device.offShift': 'خارج الوردية',
  'notCarried.passes':
    '{n, plural, one {تصريح زيارة واحد} two {تصريحا زيارة} few {# تصاريح زيارة} many {# تصريح زيارة} other {# تصريح زيارة}}',
  'notCarried.workers':
    '{n, plural, one {بطاقة عامل واحدة} two {بطاقتا عامل} few {# بطاقات عمال} many {# بطاقة عامل} other {# بطاقة عامل}}',
  notCarried: '{what} تعمل عبر الإنترنت فقط حتى إعادة إصدارها',
};

export default ar;
