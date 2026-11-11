import type { Translation } from '@jiwar/i18n';
import type en from '../en/po-receive.ts';

const ar: Translation<typeof en> = {
  title: 'استلام {reference}',
  description:
    'سجّل ما وصل: لكل بند الكمية المقبولة، وما رُفض مع سببه. التسليم على دفعات يعني عدة أذون استلام. يدخل المخزون المقبول إلى المخزن بسعر أمر الشراء.',
  forbiddenTitle: 'الاستلام',
  back: 'العودة إلى الأمر',
  notOpen: 'هذا الأمر غير مفتوح للاستلام.',
  serviceOnly: 'يمكنك تأكيد بنود الخدمة في الأمر فقط.',
  nothingLeft: 'استُلم كل ما طُلب.',
  'col.line': 'البند',
  'col.ordered': 'المطلوب',
  'col.left': 'المتبقي',
  'col.accepted': 'المقبول',
  'col.rejected': 'المرفوض',
  'col.reason': 'السبب',
  'col.note': 'ملاحظة',
  chooseReason: 'السبب',
  receivedOn: 'تاريخ الاستلام',
  deliveryNote: 'رقم إذن تسليم المورد',
  note: 'ملاحظة',
  store: 'المخزن',
  storeHint: 'يدخل المخزون المقبول إلى هذا المخزن.',
  chooseStore: 'اختر مخزنًا',
  storeNoAccess: 'المخازن تظهر للأدوار التي تتولى المخزون: استلام أصناف المخزون يحتاج إلى هذه الصلاحية.',
  photos: 'صور التسليم',
  addPhoto: 'أضف صورة',
  photoCount: 'أُرفقت {count} من {max} صور.',
  removePhotos: 'احذف الصور',
  submit: 'سجّل الاستلام',
  recorded: 'سُجّل برقم {reference}.',
  exceeds: 'يمكن قبول {max} {unit} كحد أقصى.',
};

export default ar;
