import type { Translation } from '@jiwar/i18n';
import type en from '../en/ops-purchases.ts';

const ar: Translation<typeof en> = {
  title: 'طلبات الشراء',
  description: 'ما يطلب الموظفون شراءه. ما يتجاوز حد المدير يغطيه عقد كبير اعتمده مجلس الإدارة.',
  approved: 'اعتُمد الطلب {reference}.',
  rejected: 'رُفض الطلب {reference}.',
  fulfilled: 'سُجل الطلب {reference} كمُشترى.',
  approve: 'اعتمد',
  reject: 'ارفض',
  fulfil: 'سجّل الشراء',
  status: 'الحالة',
  'view.requested': 'قيد الانتظار',
  'view.approved': 'معتمدة',
  'view.fulfilled': 'تم شراؤها',
  'view.all': 'الكل',
  empty: 'لا توجد طلبات شراء',
  'col.request': 'الطلب',
  'col.amount': 'المبلغ',
  'col.neededBy': 'مطلوب قبل',
  'col.status': 'الحالة',
};

export default ar;
