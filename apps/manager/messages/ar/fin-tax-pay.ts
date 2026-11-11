import type { Translation } from '@jiwar/i18n';
import type en from '../en/fin-tax-pay.ts';

const ar: Translation<typeof en> = {
  dueVat: 'المتبقي سداده: {amount}. يخرج من حساب في الخزينة مقابل ضريبة القيمة المضافة المستحقة.',
  dueWithholding: 'المتبقي سداده: {amount}. يخرج من حساب في الخزينة مقابل ضريبة الخصم من المنبع المستحقة.',
  amount: 'المبلغ، ج.م',
  paidOn: 'تاريخ السداد',
  method: 'طريقة السداد',
  reference: 'إيصال مصلحة الضرائب أو مرجع التحويل',
  pay: 'سدّد',
  done: 'سُجّل برقم {number}.',
};

export default ar;
