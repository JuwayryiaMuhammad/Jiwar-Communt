import type { Translation } from '@jiwar/i18n';
import type en from '../en/res-ownership-transfers.ts';

const ar: Translation<typeof en> = {
  title: 'نقل الملكية',
  description: 'وحدات تنتقل ملكيتها. اطلب النقل من صفحة الوحدة، ووافق عليه هنا بعد مراجعة المستحقات.',
  show: 'عرض',
  'view.pending': 'قيد الانتظار',
  'view.done': 'تمت',
  'view.cancelled': 'ملغاة',
  none: 'لا توجد عمليات نقل هنا',
  noneHint: 'اطلب النقل من صفحة الوحدة: نقل الملكية.',
  'col.transfer': 'النقل',
  'col.unit': 'الوحدة',
  'col.buyer': 'المالك الجديد',
  'col.requested': 'تاريخ الطلب',
  'col.owed': 'المستحق',
  nothing: 'لا شيء',
  exception: 'استثناء: {reason}',
  cancelled: 'أُلغي النقل.',
  cancelTitle: 'إلغاء النقل',
  cancelDescription: 'لا يتغير شيء في الوحدة.',
  approved: 'انتقلت الملكية. انتهى الإشغال السابق وانتهت الأسرة؛ وأُبلغ كل شخص.',
  stepTitle: 'أكّد أنك أنت',
  stepDescription: 'نقل وحدة عليها مستحقات للكمبوند استثناء: أرسلنا رمزًا إلى بريدك الإلكتروني.',
  approveTitle: 'الموافقة على {reference}؟',
  approveDescription: 'تنتقل الوحدة {unit} إلى {buyer}. ينتهي كل إشغال حالي وتنتهي الأسرة معه؛ ولا يمكن التراجع.',
  theNewOwner: 'المالك الجديد',
  approveException: 'وافق كاستثناء',
  approveTransfer: 'وافق على النقل',
  owes: 'على الوحدة مستحقات {amount}. لا تنتقل ملكيتها إلا إذا وافقت عليها كاستثناء مع ذكر السبب.',
  whyAhead: 'سبب المضي في النقل',
  selectReason: 'اختر السبب…',
  owesNothing: 'لا مستحقات على الوحدة.',
};

export default ar;
