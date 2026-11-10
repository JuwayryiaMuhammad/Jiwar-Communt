import type { Translation } from '@jiwar/i18n';
import type en from '../en/shell-overview.ts';

const ar: Translation<typeof en> = {
  title: 'نظرة عامة',
  hello: 'مرحبًا، {name}',
  description: 'يوم المجمع، {date}. ما ينتظرك، وحال كل جزء من المجمع.',
  briefs: 'الملخصات اليومية',
  'inbox.label': 'بانتظارك',
  'inbox.hint': '{n} متأخر',
  'tickets.label': 'البلاغات المفتوحة',
  'tickets.hint': '{unassigned} دون فني · {awaiting} بانتظار تأكيد الساكن',
  'sla.label': 'تجاوزت SLA',
  'sla.hint': '{n} معرّض للتأخر',
  'sla.off': 'SLA غير مفعّل',
  'emergencies.label': 'بلاغات الطوارئ المفتوحة',
  'emergencies.hint': '{n} دون فني',
  'emergencies.allAssigned': 'كلها مُسندة',
  'collected.label': 'المحصّل هذا الشهر',
  'collected.hint': '{month} · {today} اليوم',
  'owed.label': 'مستحقات فات موعدها',
  'owed.hint': '{n, plural, =0 {لا فواتير} one {فاتورة واحدة} two {فاتورتان} few {# فواتير} many {# فاتورة} other {# فاتورة}}',
  'liquidity.label': 'السيولة',
  'liquidity.hint': 'أيام الإنفاق التي يغطيها النقد',
  'incidents.label': 'حوادث اليوم',
  'incidents.hint': '{open} مفتوح',
  'incidents.hintLockdown':
    '{open} مفتوح · {lockdowns, plural, one {إغلاق أمني واحد} two {إغلاقان أمنيان} few {# إغلاقات أمنية} many {# إغلاقًا أمنيًا} other {# إغلاق أمني}}',
  'gate.label': 'دخول البوابة اليوم',
  'gate.hint': '{visitors} زائر · {exits} خروج',
  'outages.label': 'الانقطاعات القائمة',
  'outages.hint': '{n} لاحقًا اليوم',
  'units.label': 'الوحدات',
  'units.hint': '{occupied} مشغولة · {vacant} شاغرة · {closed} مغلقة',
  needsTitle: 'ما ينتظرك الآن',
  needsHint: 'الحرج أولًا، ثم المتأخر.',
  inbox: 'صندوق الوارد',
  'severity.critical': 'حرج',
  'severity.warning': 'تنبيه',
  overdueSince: 'متأخر منذ {when}',
  due: 'الموعد {when}',
  allClear: 'لا شيء ينتظر',
  allClearBody: 'لا شيء حرج، ولا شيء ينتظر قرارك.',
  'alert.emergency_overdue':
    '{n, plural, one {بلاغ طوارئ واحد تجاوز} two {بلاغا طوارئ تجاوزا} few {# بلاغات طوارئ تجاوزت} many {# بلاغ طوارئ تجاوزت} other {# بلاغ طوارئ تجاوزت}} SLA',
  'alert.emergency_unassigned':
    '{n, plural, one {بلاغ طوارئ واحد} two {بلاغا طوارئ} few {# بلاغات طوارئ} many {# بلاغ طوارئ} other {# بلاغ طوارئ}} دون فني مسؤول',
  'alert.lockdown_live':
    '{n, plural, one {إغلاق أمني واحد قائم} two {إغلاقان أمنيان قائمان} few {# إغلاقات أمنية قائمة} many {# إغلاقًا أمنيًا قائمًا} other {# إغلاق أمني قائم}}',
  'alert.incident_critical_open':
    '{n, plural, one {حادث حرج واحد مفتوح} two {حادثان حرجان مفتوحان} few {# حوادث حرجة مفتوحة} many {# حادثًا حرجًا مفتوحًا} other {# حادث حرج مفتوح}}',
  'alert.tickets_overdue':
    '{n, plural, one {بلاغ واحد تجاوز} two {بلاغان تجاوزا} few {# بلاغات تجاوزت} many {# بلاغًا تجاوزت} other {# بلاغ تجاوزت}} SLA',
  'alert.service_pressure': 
    'ضغط على الخدمة: {n, plural, one {بلاغ مفتوح واحد} two {بلاغان مفتوحان} few {# بلاغات مفتوحة} many {# بلاغًا مفتوحًا} other {# بلاغ مفتوح}} مقابل الفنيين المتاحين',
  'alert.outage_active':
    '{n, plural, one {انقطاع مرافق واحد قائم} two {انقطاعا مرافق قائمان} few {# انقطاعات مرافق قائمة} many {# انقطاعًا قائمًا} other {# انقطاع قائم}}',
  'alert.meter_alert_open':
    '{n, plural, one {ارتفاع مفاجئ واحد في عداد} two {ارتفاعان مفاجئان في العدادات} few {# ارتفاعات مفاجئة في العدادات} many {# ارتفاعًا مفاجئًا في العدادات} other {# ارتفاع مفاجئ في العدادات}} لم يُراجَع بعد',
  'alert.cash_below_minimum': 'النقد المتاح أقل من الحد الأدنى للمجمع',
  'alert.cash_forecast_below_minimum':
    'ينخفض النقد عن الحد الأدنى في {n, plural, one {الفترة القادمة} two {فترتين قادمتين} few {# فترات قادمة} many {# فترة قادمة} other {# فترة قادمة}}',
  'alert.other': '{what} ({n})',
  gateTitle: 'آخر حركة على البوابة',
  log: 'السجل',
  in: 'دخول',
  out: 'خروج',
  'entry.worker': 'عامل',
  'entry.visitor': 'زائر',
  'entry.visit': 'زيارة معتمدة',
  gate: 'البوابة',
  noEntries: 'لا توجد حركة بعد',
  buildingsTitle: 'المباني',
  buildingsHint: 'حرج: انقطاع قائم أو بلاغ طوارئ مفتوح. يحتاج انتباهًا: بلاغ تجاوز SLA.',
  noBuildings: 'لا توجد مبانٍ مسجلة بعد',
  'col.building': 'المبنى',
  'col.status': 'الحالة',
  'col.occupied': 'المشغولة',
  'col.open': 'البلاغات المفتوحة',
  'col.overdue': 'تجاوزت SLA',
  'col.emergency': 'الطوارئ',
  'col.outages': 'الانقطاعات',
  'band.ok': 'سليم',
  'band.attention': 'يحتاج انتباهًا',
  'band.critical': 'حرج',
};

export default ar;
