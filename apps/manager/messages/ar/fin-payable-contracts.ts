import type { Translation } from '@jiwar/i18n';
import type en from '../en/fin-payable-contracts.ts';

const ar: Translation<typeof en> = {
  title: 'الدفعات المقدمة والمحتجزات والضمانات',
  description:
    'تُقاصّ الدفعة المقدمة من فواتير العقد اللاحقة؛ ويُفرج عن المحتجز من كل دفعة عند انتهاء العقد. لا يعتمد أحد ما طلبه بنفسه.',
  waiting: 'بانتظار قرار أو صرف',
  waitingEmpty: 'لا شيء بانتظار',
  request: 'الطلب',
  itsContract: 'عقده',
  contractId: 'معرّف العقد',
  approve: 'اعتمد',
  turnDown: 'ارفض',
  payToday: 'ادفع اليوم',
  approved: 'تم اعتماد {number}.',
  paid: 'تم دفع {number} برقم {payout}.',
  rejected: 'تم رفض {number}.',
  rejectTitle: 'رفض {number}؟',
  moneyTitle: 'أموال العقد',
  retentionNone: 'لا يوجد',
  summary:
    'المحتجز {pct}: {held} محتجز، و{released} أُفرج عنه، و{open} قائم. الدفعات المقدمة: {advPaid} مدفوعة، و{advSetOff} مقاصة، و{advOpen} قائمة. الفواتير: {toPay} للدفع، و{paid} مدفوعة.',
  askFor: 'اطلب',
  advance: 'دفعة مقدمة',
  release: 'الإفراج عن المحتجز (بعد انتهاء العقد)',
  egp: 'ج.م',
  ask: 'اطلب',
  asked: 'تم الطلب برقم {number}؛ أُبلغ المعتمدون.',
  noDisbursement: 'لا دفعات مقدمة ولا إفراج',
  noGuarantee: 'لا ضمانات',
  guarantee: 'الضمان',
  expires: 'ينتهي',
};

export default ar;
