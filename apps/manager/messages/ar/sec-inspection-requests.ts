import type { Translation } from '@jiwar/i18n';
import type en from '../en/sec-inspection-requests.ts';

const ar: Translation<typeof en> = {
  title: 'طلبات المعاينة',
  description: 'وحدات مغلقة يطلب ملّاكها أن يزورها الحراس. جدول الطلب كمهمة معاينة.',
  show: 'عرض',
  cancelled: 'تم الإلغاء.',
  empty: 'لا توجد طلبات هنا',
  emptyHint: 'يطلب المالك من التطبيق أثناء إغلاق وحدته.',
  'col.unit': 'الوحدة',
  'col.day': 'اليوم المفضل',
  'col.asked': 'وقت الطلب',
  schedule: 'جدولة',
  cancelTitle: 'إلغاء الطلب',
  cancelDescription: 'يرى المالك السبب. وإلغاء طلب مجدول يلغي مهمته أيضًا.',
};

export default ar;
