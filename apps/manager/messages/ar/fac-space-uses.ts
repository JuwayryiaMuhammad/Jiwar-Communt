import type { Translation } from '@jiwar/i18n';
import type en from '../en/fac-space-uses.ts';

const ar: Translation<typeof en> = {
  title: 'استخدام الأماكن المشتركة',
  description: 'يطلب السكان استخدام مكان مشترك لفترة محددة، وتقرر الإدارة.',
  openTitle: 'الأماكن التي يمكن للسكان طلبها',
  openPick: 'المكان المشترك المراد فتحه',
  openPlaceholder: 'افتح مكانًا مشتركًا…',
  openEmpty: 'لا يوجد مكان مفتوح للطلبات',
  facilityNote: 'مرفق: يُغلق أمام الحجز أثناء استخدامه',
  opened: 'يمكن للسكان طلبه الآن.',
  closedToRequests: 'لن يقبل طلبات جديدة، وتبقى الطلبات السابقة كما هي.',
  empty: 'لا توجد طلبات',
  'col.when': 'الموعد',
  'col.area': 'المكان',
  'col.purpose': 'الغرض',
  'col.guests': 'الضيوف',
  refuse: 'رفض',
  approvedToast: 'تمت الموافقة، وتم إبلاغ مقدّم الطلب.',
  refusedToast: 'تم الرفض، وتم إبلاغ مقدّم الطلب.',
  cancelledToast: 'تم الإلغاء، وتم إبلاغ مقدّم الطلب.',
  refuseTitle: 'رفض الطلب؟',
  cancelTitle: 'إلغاء الاستخدام الموافق عليه؟',
  told: 'يُبلَّغ مقدّم الطلب مع ذكر السبب.',
  cancelUse: 'إلغاء الاستخدام',
};

export default ar;
