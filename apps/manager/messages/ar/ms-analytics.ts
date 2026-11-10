import type { Translation } from '@jiwar/i18n';
import type en from '../en/ms-analytics.ts';

const ar: Translation<typeof en> = {
  analytics: 'التحليلات',
  'field.recurrenceMinTickets': 'أعطال متكررة تستدعي صيانة مخططة (2–20)',
  'field.recurrenceWindowDays': 'تُحسب خلال (أيام، 7–366)',
  'field.caseMinTickets': 'بلاغات الساكنين التي تفتح حالة مجتمعية (2–20)',
  'field.caseWindowDays': 'تُحسب خلال (أيام، 1–180)',
  analyticsSaved: 'تم حفظ إعدادات التحليلات.',
  pressure: 'ضغط الخدمة',
  pressureHint:
    'عندما تصل البلاغات المفتوحة (الجديدة أو التي مع الفني) إلى هذا العدد لكل فني متاح، يُبلَّغ مشرفو الصيانة والمديرون: مرة عند كل ارتفاع، ومرة واحدة في الساعة على الأكثر مهما تكرر الارتفاع والانخفاض. اتركه فارغًا لإيقاف التنبيه.',
  underPressure: 'تحت الضغط',
  withinCapacity: 'ضمن الطاقة',
  counts: '{open} مفتوح · {available} متاح',
  since: ' · منذ {when}',
  threshold: 'البلاغات المفتوحة لكل فني متاح (1–100)',
  saveThreshold: 'احفظ الحد',
  alertOff: 'تم إيقاف تنبيه ضغط الخدمة.',
  thresholdSaved: 'تم حفظ الحد.',
};

export default ar;
