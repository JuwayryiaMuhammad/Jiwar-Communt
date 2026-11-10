import type { Translation } from '@jiwar/i18n';
import type en from '../en/gov-approvals.ts';

const ar: Translation<typeof en> = {
  title: 'طلبات الموافقة',
  description:
    'ما يقرره مجلس الإدارة: عقد يتجاوز حد المدير، أو زيادة في الميزانية، أو رسم، أو تنازل، أو خطة تتجاوز حدها، أو إجراء قانوني. أما الميزانيات السنوية فتُرفع من صفحتها.',
  raise: 'ارفع طلبًا',
  'view.pending': 'لدى مجلس الإدارة',
  'view.approved': 'معتمدة، للتنفيذ',
  'view.implemented': 'نُفذت',
  'view.rejected': 'مرفوضة',
  'view.withdrawn': 'مسحوبة',
  nothing: 'لا يوجد شيء هنا',
  'col.request': 'الطلب',
  'col.cost': 'التكلفة',
  'col.raised': 'تاريخ الرفع',
  'col.deadline': 'الموعد النهائي',
  raisedByYou: '{when} · بواسطتك',
  deadlineOverdue: '{when} · متأخر',
  requestTitle: 'الطلب',
  implementedToast: 'سُجّل التنفيذ. أُبلغ مجلس الإدارة.',
  implementedTitle: 'تسجيل الطلب منفذًا؟',
  implementedDescription: 'مرة واحدة: يرى المجلس وقت التنفيذ وملاحظتك.',
  noteOptional: 'ملاحظة (اختياري)',
  markImplemented: 'سجّل التنفيذ',
  withdrawn: 'سُحب الطلب. أُغلق أي مقترح مفتوح عليه، وأُبلغ مجلس الإدارة.',
  withdraw: 'اسحب',
  withdrawTitle: 'سحب الطلب؟',
  withdrawDescription: 'يتوقف المجلس عن البت فيه؛ وتعود الميزانية المرفوعة إلى حالة السحب، وتُعد ميزانية جديدة.',
};

export default ar;
