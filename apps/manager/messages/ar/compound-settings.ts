import type { Translation } from '@jiwar/i18n';
import type en from '../en/compound-settings.ts';

const ar: Translation<typeof en> = {
  title: 'الإعدادات',
  description: 'قواعد على مستوى الكمبوند للأسر والزوار والبوابة.',
  discard: 'تراجع',
  saved: 'تم حفظ الإعدادات.',
  compound: 'الكمبوند',
  timezone: 'المنطقة الزمنية',
  timezoneHint: 'اسم IANA، مثل Africa/Cairo. تعتمد عليها الجداول والحضور.',
  emergencyPhone: 'هاتف الطوارئ',
  emergencyPhoneHint: 'يظهر في صفحة الزائر وبطاقة العامل وجهات الطوارئ لكل وحدة.',
  officePhone: 'هاتف مكتب الكمبوند',
  officePhoneHint: 'يظهر في جهات الطوارئ لكل وحدة.',
  dutyPhone: 'هاتف المدير المناوب',
  dutyPhoneHint: 'يظهر في جهات الطوارئ لكل وحدة، وتراه الأسرة عندما ترد الإدارة على حالة طارئة.',
  directions: 'إرشادات الوصول للزوار',
  directionsHint: 'تظهر في صفحة تصريح الزائر.',
  households: 'الأسر',
  approvalRequired: 'يحتاج أفراد الأسرة الجدد إلى موافقة المدير',
  maxMembers: 'أقصى عدد أفراد للأسرة',
  visitorsAndGate: 'الزوار والبوابة',
  maxPasses: 'تصاريح الزوار السارية لكل وحدة',
  gateTimeout: 'مهلة موافقة البوابة (بالثواني)',
  gateTimeoutHint: 'المدة المتاحة للأسرة للرد على البوابة قبل أن تُطبَّق تعليمات البوابة الخاصة بها (30–1800).',
  alwaysAllow: 'يجوز للأسر أن تطلب من البوابة السماح دائمًا لشخص معيّن بالدخول',
  alwaysAllowNote:
    'عند الإيقاف لا يمكن إضافة تعليمات «السماح دائمًا» جديدة، ويعامل الحارس الموجود منها على أنه «اتصل أولًا». ويسجّل الحارس كل دخول في الحالتين.',
};

export default ar;
