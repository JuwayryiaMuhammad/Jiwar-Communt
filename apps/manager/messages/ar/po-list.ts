import type { Translation } from '@jiwar/i18n';
import type en from '../en/po-list.ts';

const ar: Translation<typeof en> = {
  title: 'أوامر الشراء',
  description:
    'ما يطلبه المجمع من الموردين: يعتمده شخص غير الذي أصدره، ويُستلم على دفعات، ثم يُفوتر وتُطابَق فاتورته مع ما وصل.',
  raise: 'إصدار أمر شراء',
  settingsLink: 'إعدادات أمر الشراء والمطابقة',
  view: 'العرض',
  'view.waiting': 'بانتظار الاعتماد',
  'view.all': 'الكل',
  status: 'الحالة',
  anyStatus: 'أي حالة',
  vendor: 'المورد',
  anyVendor: 'كل الموردين',
  empty: 'لا توجد أوامر شراء',
  emptyWaiting: 'لا يوجد أمر أو مراجعة بانتظار القرار',
  'col.order': 'أمر الشراء',
  'col.vendor': 'المورد',
  'col.total': 'الإجمالي',
  'col.status': 'الحالة',
  'col.delivery': 'التسليم',
  'col.raised': 'تاريخ الإصدار',
};

export default ar;
