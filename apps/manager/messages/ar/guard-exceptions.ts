import type { Translation } from '@jiwar/i18n';
import type en from '../en/guard-exceptions.ts';

const ar: Translation<typeof en> = {
  'kind.worker_outside_hours': 'عامل خارج مواعيده',
  'kind.visitor_without_pass': 'زائر بلا تصريح زيارة',
  'kind.unregistered_vehicle': 'مركبة غير مسجلة',
  purgedVehicle: 'مركبة (حُذفت بياناتها)',
  aWorker: 'عامل',
  purgedVisitor: 'زائر (حُذفت بياناته)',
  'setting.exceptionAnswerMinutes': 'دقائق الرد على استثناء ميداني',
  'setting.exceptionEntryMinutes': 'دقائق الدخول المسموح بها بعد اعتماد الاستثناء',
  'setting.visitExpectedMinutes': 'المدة المتوقعة للزيارة بالدقائق، إن لم يحددها التصريح',
  'setting.geofenceExitMinutes': 'دقائق خروج الدورية من نطاقها قبل التنبيه',
  'setting.audioMaxSeconds': 'أطول تسجيل صوتي، بالثواني',
  'setting.videoMaxSeconds': 'أطول تسجيل فيديو، بالثواني',
  'setting.audioMaxMb': 'أكبر حجم لتسجيل صوتي، بالميجابايت',
  'setting.videoMaxMb': 'أكبر حجم لتسجيل فيديو، بالميجابايت',
  'setting.offlineSyncAlertMinutes': 'دقائق غياب جهاز البوابة أثناء الوردية قبل إبلاغك',
  'setting.callRingSeconds': 'ثواني رنين المكالمة من البوابة قبل اعتبارها فائتة',
  'setting.callMaxSeconds': 'أقصى مدة للمكالمة من البوابة بعد الرد، بالثواني',
  'setting.gateBusyNormalFrom': 'عدد مرات الدخول في 15 دقيقة التي تُعد البوابة عندها عادية',
  'setting.gateBusyBusyFrom': 'عدد مرات الدخول في 15 دقيقة التي تُعد البوابة عندها مزدحمة (فوق العادي)',
  'setting.closedUnitRoundDays': 'الأيام بين جولات الوحدة المغلقة، من إغلاقها أو آخر فحص لها',
};

export default ar;
