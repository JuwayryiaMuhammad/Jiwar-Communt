import type { Translation } from '@jiwar/i18n';
import type en from '../en/gov-settings.ts';

const ar: Translation<typeof en> = {
  title: 'إعدادات مجلس الإدارة',
  description:
    'عدد الأيام التي يملكها المجلس للبت في كل نوع من الطلبات؛ وبعد انقضائها يُبلَّغ المجلس والإدارة مرة واحدة. تُعرض الحدود على المجلس مع كل طلب؛ وحد العقد الكبير ملزم دائمًا، أما حدا التنازل وخطة السداد فيلزمان حين تجعلهما ملزمين.',
  saved: 'تم الحفظ. الطلبات المرفوعة سابقًا تحتفظ بمواعيدها.',
  typeBoardAppeal: 'تظلم أمام مجلس الإدارة',
  'hint.major_contract': 'حد المدير: المصروف الذي يتجاوزه يحتاج إلى عقد وافق عليه مجلس الإدارة.',
  'hint.waiver_above_limit': 'حين يكون ملزمًا: رصيد الاعتراض الذي يتجاوزه يحتاج إلى تنازل وافق عليه مجلس الإدارة (ADR 0073).',
  'hint.payment_plan_above_limit': 'حين يكون ملزمًا: خطة السداد التي تتجاوزه تحتاج إلى خطة وافق عليها مجلس الإدارة (ADR 0073).',
  'col.matter': 'الطلب',
  'col.days': 'أيام البت',
  'col.threshold': 'الحد (ج.م)',
  'col.binding': 'الإلزام',
  daysAria: 'أيام البت: {matter}',
  thresholdAria: 'الحد: {matter}',
  none: 'بلا حد',
  aboveItBoardDecides: 'ما فوقه يقرره مجلس الإدارة',
  always: 'دائمًا',
};

export default ar;
