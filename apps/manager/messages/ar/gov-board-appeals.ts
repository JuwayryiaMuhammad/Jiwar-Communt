import type { Translation } from '@jiwar/i18n';
import type en from '../en/gov-board-appeals.ts';

const ar: Translation<typeof en> = {
  title: 'التظلمات أمام مجلس الإدارة',
  description:
    'رفعت وحدة قرارًا للإدارة إلى مجلس الإدارة. التظلم المعلّق يوقف سداد الغرامة أو المخالفة؛ وإذا ألغى المجلس قرارًا لا يستطيع النظام تنفيذ إلغائه، فهو ينتظر منك المتابعة.',
  'view.pending': 'لدى مجلس الإدارة',
  'view.upheld': 'أُيد القرار',
  'view.overturned': 'أُلغي القرار',
  'view.withdrawn': 'مسحوب',
  nothing: 'لا يوجد شيء هنا',
  'col.appeal': 'التظلم',
  'col.of': 'بشأن',
  'col.unit': 'الوحدة',
  'col.deadline': 'الموعد النهائي',
  'col.effect': 'الأثر',
  deadlineOverdue: '{when} · متأخر',
  appealTitle: 'التظلم',
  headingUnit: '{reference} · {kind} · الوحدة {unit}',
  followedToast: 'سُجلت المتابعة.',
  markFollowed: 'سجّل المتابعة',
  pastDeadline: 'تجاوز موعده النهائي',
  lodged: 'تاريخ التقديم',
  deadline: 'مهلة مجلس الإدارة',
  withdrawn: 'تاريخ السحب',
  decided: 'تاريخ القرار',
  reasons: 'أسباب مجلس الإدارة',
  effect: 'الأثر',
  followedUp: 'تمت المتابعة {when}',
  managementDecision: 'قرار الإدارة',
  openAppeal: 'افتح التظلم الذي بتّت فيه',
  openAppealFollow: 'لتنفيذ ما ألغاه المجلس، ثم سجّل المتابعة هنا.',
  complaint: 'الشكوى',
  complaintOwn: 'صاحبها وأسبابها من شأن المجلس وحده.',
  complaintFollow: 'رأى المجلس أن الشكوى في محلها: اتخذ اللازم، ثم سجّل المتابعة هنا.',
  dispute: 'الاعتراض',
  openDispute: 'افتحه في الاعتراضات',
  openDisputeFollow: 'لإضافة رصيد دائن إلى الفاتورة، ثم سجّل المتابعة هنا.',
};

export default ar;
