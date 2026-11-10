import type { Translation } from '@jiwar/i18n';
import type en from '../en/res-identity-changes.ts';

const ar: Translation<typeof en> = {
  title: 'تغيير الاسم ورقم الهاتف',
  description: 'يطلب الساكن التغيير، وتراجع أنت القيمة الجديدة على مستنداته، ثم توافق أو ترفض. لا يتغير شيء حتى تقرر.',
  approved: 'تم التغيير. أُبلغ الساكن.',
  rejected: 'تم الرفض. أُبلغ الساكن بالسبب.',
  none: 'لا توجد طلبات تغيير',
  noneHint: 'يطلب الساكن التغيير من التطبيق بعد أن يؤكد هويته.',
  'col.account': 'الحساب',
  'col.what': 'المطلوب تغييره',
  'col.now': 'الحالي',
  'col.asked': 'المطلوب',
  'col.when': 'تاريخ الطلب',
  family: 'فرد من الأسرة',
  resident: 'ساكن',
  name: 'الاسم',
  phone: 'الهاتف',
  rejectTitle: 'رفض التغيير',
  rejectDescription: 'يرى الساكن السبب، وتُمحى القيمة التي طلبها.',
};

export default ar;
