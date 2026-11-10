import type { Translation } from '@jiwar/i18n';
import type en from '../en/economics.ts';

const ar: Translation<typeof en> = {
  title: 'التكلفة والأداء',
  description: 'ما أُنفق، وخطة السنوات القادمة، وكيف سار العمل، على مدى أيام المجمع.',
  plannedWork: 'الأعمال المخططة',
  plannedHint: '{planned} مخطط، {repairs} إصلاح',
  mttr: 'متوسط وقت الإصلاح',
  hours: '{n} ساعة',
  mtbf: 'متوسط الوقت بين الأعطال',
  days: '{n, plural, one {يوم واحد} two {يومان} few {# أيام} many {# يومًا} other {# يوم}}',
  failures: '{n, plural, =0 {لا أعطال} one {عطل واحد} two {عطلان} few {# أعطال} many {# عطلًا} other {# عطل}}',
  onTime: 'الخطط في موعدها',
  onTimeHint: '{onTime} من {due}',
  spend: 'المصروفات',
  spendLine: '{total} · مخطط {planned} · إصلاحات {repairs}',
  nothingSpent: 'لم يُصرف شيء',
  month: 'الشهر',
  costMost: 'الأعلى تكلفة',
  noCost: 'لم تكلّف أعمال أي أصل شيئًا',
  asset: 'الأصل',
  ahead: 'الاستبدالات القادمة',
  year: 'السنة',
  assets: 'الأصول',
  reserve: 'الاحتياطي: {annual} في السنة، المتراكم منه {accrued}.',
  byCategory: 'حسب الفئة',
  technicians: 'الفنيون',
  noTechnician: 'لا يوجد فني',
  technician: 'الفني',
  completed: 'المكتمل',
  hoursToComplete: 'ساعات الإنجاز',
  sentBack: 'أُعيد للمراجعة',
  slaMet: 'الالتزام بمهلة الخدمة',
  rating: 'التقييم',
  inHand: 'قيد التنفيذ',
};

export default ar;
