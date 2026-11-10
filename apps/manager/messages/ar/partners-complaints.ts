import type { Translation } from '@jiwar/i18n';
import type en from '../en/partners-complaints.ts';

const ar: Translation<typeof en> = {
  title: 'شكاوى الشركاء',
  description: 'ما اشتكى منه الساكنون في حق شريك، والتعويض الذي طلبوه. لا يُدفع شيء عبر جوار: يصدر إشعار الدائن من المالية.',
  shown: 'الشكاوى المعروضة',
  'view.toDecide': 'بانتظار القرار',
  'view.decided': 'تم البت فيها',
  emptyToDecide: 'لا شكاوى بانتظار القرار',
  empty: 'لا توجد شكاوى',
  'col.complaint': 'الشكوى',
  'col.partner': 'الشريك',
  'col.asks': 'المطلوب',
  'col.decision': 'القرار',
  'col.made': 'وقت التقديم',
  complaint: 'شكوى',
  openConversation: 'افتح المحادثة',
  decide: 'اتخذ قرارًا',
  request: 'الطلب',
  notDecided: 'لم يُتخذ قرار بعد',
  'decide.title': 'القرار في هذه الشكوى',
  'decide.description': 'مرة واحدة. يصدر إشعار الدائن من صفحة المالية نفسها: لا يُدفع شيء هنا.',
  'decide.done': 'اتُّخذ القرار، وأُبلغ الساكن.',
  outcome: 'النتيجة',
  arrangement: 'ما ترتّبه الإدارة',
};

export default ar;
