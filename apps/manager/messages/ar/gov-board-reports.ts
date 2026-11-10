import type { Translation } from '@jiwar/i18n';
import type en from '../en/gov-board-reports.ts';

const ar: Translation<typeof en> = {
  reportsTitle: 'تقارير مجلس الإدارة',
  reportsDescription: 'أرقام مجلس الإدارة لكل شهر، إلى جانب الماليات ونظرة الأمن العامة.',
  drawn: 'أُعد التقرير: {month}، الإصدار {version}.',
  drawTitle: 'أعدّ تقرير شهر',
  month: 'الشهر',
  monthHint: 'حتى الشهر الحالي',
  draw: 'أعدّ',
  noReport: 'لا يوجد تقرير بعد',
  'col.version': 'الإصدار',
  'col.written': 'تاريخ الإعداد',
  versionMonthly: '{version} · شهري',
  handoverTitle: 'ملفات التسليم',
  handoverDescription: 'ما تركه المجلس السابق مفتوحًا حين بدأ هذا المجلس عمله، ومذكرات تسليم المديرين.',
  pdfFailed: 'تعذر تنزيل ملف PDF.',
  packPdf: 'الملف بصيغة PDF',
  packTitle: 'ملف تسليم مجلس الإدارة',
  noPack: 'لا يوجد ملف تسليم لهذا المجلس: بدأ عمله قبل إعداد ملفات التسليم، أو لا يوجد مجلس قائم.',
  packWritten: 'أُعد {when} · اعتراضات بلا رد: {objections} · مقترحات مفتوحة: {proposals}',
  'pack.pending': '{reference} · {type} · بانتظار مجلس الإدارة',
  'pack.toImplement': '{reference} · {type} · معتمد، للتنفيذ',
  'pack.appeal': '{reference} · {kind} · تظلم بانتظار مجلس الإدارة',
  'pack.action': '{meeting} · {title} · مستحقة في {day}',
  'pack.contract': '{code} · {kind} · ينتهي العقد في {day}',
  nothingOpen: 'لم يُترك شيء مفتوحًا.',
  managersTitle: 'مذكرات تسليم المديرين',
  noneDelivered: 'لم تُسلَّم أي مذكرة',
  'col.manager': 'المدير',
  'col.delivered': 'تاريخ التسليم',
};

export default ar;
