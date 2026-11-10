import type { Translation } from '@jiwar/i18n';
import type en from '../en/fin-plan-requests.ts';

const ar: Translation<typeof en> = {
  title: 'طلبات التقسيط',
  description: 'خطط تقسيط طلبها السكان على فواتير مستحقة عليهم.',
  'status.pending': 'قيد الانتظار',
  'status.accepted': 'مقبولة',
  'status.declined': 'مرفوضة',
  'status.withdrawn': 'مسحوبة',
  'status.lapsed': 'سقطت',
  empty: 'لا توجد طلبات',
  'col.invoice': 'الفاتورة',
  'col.months': 'الأشهر المطلوبة',
  'col.asked': 'تاريخ الطلب',
  accept: 'اقبل',
  decline: 'ارفض',
  accepted: 'أصبحت {invoice} خطة تقسيط من {n, plural, =0 {لا أقساط} one {قسط واحد} two {قسطين} few {# أقساط} many {# قسطًا} other {# قسط}}.',
  acceptTitle: 'قبول طلب التقسيط على {invoice}',
  acceptDescription:
    'طُلب على {months, plural, =0 {0 شهر} one {شهر واحد} two {شهرين} few {# أشهر} many {# شهرًا} other {# شهر}}. يجب أن يساوي مجموع الأقساط ما تستحقه الفاتورة الآن، كما لو قسّطتها بنفسك.',
  owedNow: 'المستحق الآن: {amount}',
  rowDue: 'القسط {n}، تاريخ الاستحقاق',
  egp: 'ج.م',
  declined: 'رُفض الطلب: يُبلَّغ الساكن بالسبب حسب رمزه.',
  declineTitle: 'رفض طلب التقسيط على {invoice}',
  why: 'السبب',
  saved: 'تم الحفظ: يُطبَّق من الطلب والإشعار التاليين.',
  terms: 'شروط السكان',
  maxMonths: 'أقصى عدد أشهر يمكن أن يطلبه الساكن',
  maxMonthsHint: 'من 2 إلى 24.',
  offerFrom: 'اعرض التقسيط ابتداءً من، ج.م',
  offerFromHint: 'الفاتورة التي يبقى عليها هذا المبلغ أو أكثر يُعرض عليها التقسيط مع إشعار قرب استحقاقها. فارغ: لا يُعرض أبدًا.',
  duesNotice: 'نبّه الوحدة إذا كانت مستحقات الشهر القادم أعلى بكثير من الأشهر السابقة',
};

export default ar;
