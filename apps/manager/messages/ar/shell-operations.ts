import type { Translation } from '@jiwar/i18n';
import type en from '../en/shell-operations.ts';

const ar: Translation<typeof en> = {
  economics: 'اقتصاديات الأصل',
  advice: 'التوصية',
  adviceWith: '{advice} — {reasons}',
  spent: 'إجمالي ما أُنفق',
  spentSplit: '{total} (تصحيحية {corrective}، مخططة {planned})',
  lastYear: 'آخر اثني عشر شهرًا',
  failures: 'الأعطال',
  mtbf: 'متوسط الأيام بين الأعطال',
  downtime: 'مدة التوقف',
  downtimeDays: '{n, plural, =0 {لا أيام} one {يوم واحد} two {يومان} few {# أيام} many {# يومًا} other {# يوم}}',
  downtimeWithCost: '{n, plural, =0 {لا أيام} one {يوم واحد} two {يومان} few {# أيام} many {# يومًا} other {# يوم}} · {cost}',
  replacementDue: 'موعد الاستبدال',
  reserve: 'الاحتياطي',
  reserveText: '{annual} سنويًا · {accrued} متراكم',
  underContract: 'مشمول بعقد',
  until: 'حتى {day}',
};

export default ar;
