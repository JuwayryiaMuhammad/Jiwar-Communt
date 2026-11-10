import type { Translation } from '@jiwar/i18n';
import type en from '../en/sec-alarm-devices.ts';

const ar: Translation<typeof en> = {
  title: 'أجهزة الإنذار القابلة للارتداء',
  description: 'أجهزة سقوط الحارس التي يرتديها الحراس أثناء الوردية.',
  register: 'تسجيل',
  'status.active': 'في الخدمة',
  'status.retired': 'خارج الخدمة',
  empty: 'لا توجد أجهزة',
  'col.label': 'التسمية',
  'col.vendorId': 'رقم المورد',
  'col.wornBy': 'يرتديه',
  inService: 'في الخدمة',
  retiredBadge: 'خارج الخدمة',
  retiredBadgeWithReason: 'خارج الخدمة: {reason}',
  aGuard: 'حارس',
  wornSince: '{guard} منذ {since}',
  rename: 'إعادة تسمية',
  retire: 'إخراج من الخدمة',
  renamed: 'تمت إعادة التسمية.',
  registered: 'تم التسجيل. يمكن لحارس في الوردية ربطه الآن.',
  retired: 'خرج من الخدمة وانتهى ربطه.',
  renameTitle: 'إعادة تسمية {label}',
  registerTitle: 'تسجيل جهاز إنذار سقوط للحارس',
  registerDescription: 'برقم الجهاز لدى المورد. يربطه الحارس طوال ورديته، وسقوطه أو سكونه أو زر الذعر فيه يطلق إنذار الطوارئ (SOS) الخاص بالحارس.',
  deviceId: 'رقم الجهاز لدى المورد',
  label: 'التسمية',
  labelHint: 'الاسم الذي يناديه به الحراس: لون أو رقم.',
  retireTitle: 'إخراج {label} من الخدمة؟',
  retireDescription: 'ينتهي ربطه الآن، وأي إنذار منه بعد ذلك يصل إلى غرفة التحكم فقط.',
};

export default ar;
