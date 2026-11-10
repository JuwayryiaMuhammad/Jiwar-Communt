import type { Translation } from '@jiwar/i18n';
import type en from '../en/sla-report.ts';

const ar: Translation<typeof en> = {
  title: 'تقرير اتفاقية الخدمة',
  description:
    'العدّادات التي انتهت خلال الفترة، سواء التزمت بالمهلة أو تجاوزتها، حسب الفئة والأولوية والعدّاد. العدّاد الذي أُوقف بسبب إيقاف اتفاقية الخدمة لا يُحتسب له حكم.',
  exportCsv: 'تصدير CSV',
  from: 'من',
  to: 'إلى',
  metBreached: 'التزم: {met} · تجاوز: {breached}',
  empty: 'لم ينتهِ أي عدّاد في هذه الفترة',
  'col.category': 'الفئة',
  'col.priority': 'الأولوية',
  'col.clock': 'العدّاد',
  'col.met': 'التزم',
  'col.breached': 'تجاوز',
  'col.rate': 'نسبة الالتزام',
};

export default ar;
