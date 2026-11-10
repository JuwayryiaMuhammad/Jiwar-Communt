import type { Translation } from '@jiwar/i18n';
import type en from '../en/sec-gate-devices.ts';

const ar: Translation<typeof en> = {
  title: 'أجهزة البوابة',
  description: 'هواتف تعمل بها البوابة دون اتصال. تأكد أن كل جهاز يزامن بياناته، وألغِ جهازًا ضاع أو لا تعرفه.',
  shown: 'الأجهزة المعروضة',
  'filter.active': 'نشطة',
  'filter.revoked': 'ملغاة',
  empty: 'لا توجد أجهزة بوابة',
  'col.device': 'الجهاز',
  'col.now': 'الآن',
  'col.lastSeen': 'آخر ظهور',
  'col.onDevice': 'على الجهاز',
  'col.enrolledBy': 'سجّله',
  deviceFallback: 'جهاز {id}',
  erasedAccount: 'حساب محذوف',
  revoke: 'إلغاء الجهاز',
  revoked: 'تم إلغاء الجهاز: لن ينزّل شيئًا بعد الآن، وما يرفعه ينتظرك في تنبيهات العمل دون اتصال.',
  revokeTitle: 'إلغاء {label}؟',
  thisDevice: 'هذا الجهاز',
  revokeDescriptionPending:
    '{n, plural, one {ذكر الجهاز أن عليه إجراءً واحدًا لم يُرفع بعد: كل ما يرفعه بعد هذا يوضع في الحجر لتقبله أو ترفضه.} two {ذكر الجهاز أن عليه إجراءين لم يُرفعا بعد: كل ما يرفعه بعد هذا يوضع في الحجر لتقبله أو ترفضه.} few {ذكر الجهاز أن عليه # إجراءات لم تُرفع بعد: كل ما يرفعه بعد هذا يوضع في الحجر لتقبله أو ترفضه.} many {ذكر الجهاز أن عليه # إجراءً لم يُرفع بعد: كل ما يرفعه بعد هذا يوضع في الحجر لتقبله أو ترفضه.} other {ذكر الجهاز أن عليه # إجراء لم يُرفع بعد: كل ما يرفعه بعد هذا يوضع في الحجر لتقبله أو ترفضه.}}',
  revokeDescription: 'كل ما يرفعه الجهاز بعد هذا يوضع في الحجر لتقبله أو ترفضه.',
  detailTitle: 'جهاز بوابة',
  enrolled: 'تاريخ التسجيل',
  lastUpload: 'آخر رفع',
  bundle: 'الحزمة',
  bundleValue: 'رقم {version}، حتى {until}',
  bundleNone: 'لا شيء حتى الآن',
  onShiftSuffix: ' · في الوردية',
  actionsLabel: 'الإجراءات',
  received: 'وصل منها {acked} من {max}',
  missing: ' · ناقص {n}',
  stillOnDevice: ' · {n} لا تزال على الجهاز',
  flags: 'التنبيهات',
  flagsToLook: '{n} للمراجعة',
  flagsNone: 'لا يوجد تنبيه مفتوح',
  notOffline: 'لا يعمل دون اتصال',
  revokedLabel: 'تم الإلغاء',
};

export default ar;
