import type { Translation } from '@jiwar/i18n';
import type en from '../en/fin-payable-invoice.ts';

const ar: Translation<typeof en> = {
  title: 'فاتورة مورد',
  headline: '{total} (ضريبة {tax})',
  dates: 'بتاريخ {issued}، تستحق في {due}؛ سُجّلت في {recorded}.',
  scan: 'الصورة الممسوحة',
  line: 'البند',
  tax: 'الضريبة',
  paidAs: 'دُفعت برقم {number} في {day}',
  payout: '{gross} بعد خصم {held} محتجزة و{setOff} مقاصة من الدفعات المقدمة: دُفع {net} بطريقة {method}.',
  recordedByYou: 'أنت من سجّلها: يقرر اعتمادها معتمد آخر.',
  turnDown: 'ارفض',
  callOff: 'ألغِ',
  paidOn: 'تاريخ الدفع',
  how: 'الطريقة',
  reference: 'المرجع',
  setOff: 'مقاصة من الدفعات المقدمة (ج.م)',
  payOut: 'اصرف',
  rejectTitle: 'رفض {number}؟',
  cancelTitle: 'إلغاء {number}؟',
  rejected: 'تم رفض {number}.',
  cancelled: 'تم إلغاء {number}.',
  approved: 'تم اعتماد {number}: يحجز بندها المبلغ إلى أن تُدفع.',
  paid: 'دُفعت برقم {payout}؛ سُجّل مصروفها وتحرك رصيد حسابها.',
  'tax.zero': 'بدون ضريبة',
  'tax.exempt': 'معفاة',
  'tax.vat_14': 'ضريبة القيمة المضافة 14%',
};

export default ar;
