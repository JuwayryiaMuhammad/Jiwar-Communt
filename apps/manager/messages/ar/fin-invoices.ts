import type { Translation } from '@jiwar/i18n';
import type en from '../en/fin-invoices.ts';

const ar: Translation<typeof en> = {
  title: 'الفواتير',
  description: 'ما يُطلب من كل وحدة سداده. يدفع السكان الذين يطّلعون على حسابات الوحدة إلكترونيًا أو في المكتب.',
  issue: 'أصدر فواتير',
  shown: 'الفواتير المعروضة',
  'view.open': 'مستحقة',
  'view.overdue': 'متأخرة',
  'view.paid': 'مدفوعة',
  'view.credited': 'مخصومة بإشعار دائن',
  'view.rescheduled': 'أُعيدت جدولتها',
  'view.all': 'الكل',
  any: 'الكل',
  empty: 'لا توجد فاتورة مطابقة',
  'col.invoice': 'الفاتورة',
  'col.owed': 'المستحق',
  'col.due': 'تاريخ الاستحقاق',
  'col.issued': 'تاريخ الإصدار',
  'total.withVat': '{total} (الصافي {net} + ضريبة القيمة المضافة {vat})',
};

export default ar;
