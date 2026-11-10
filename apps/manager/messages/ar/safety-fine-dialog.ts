import type { Translation } from '@jiwar/i18n';
import type en from '../en/safety-fine-dialog.ts';

const ar: Translation<typeof en> = {
  unitCode: 'كود الوحدة',
  vehicle: 'المركبة',
  vehicleHint: 'إحدى المركبات المسجلة للوحدة، أو اكتب اللوحة أدناه.',
  notRegistered: 'غير مسجلة: اكتب اللوحة',
  plate: 'اللوحة',
  reason: 'السبب',
  amount: 'المبلغ (ج.م)',
  amountInvalid: 'أكثر من صفر، و100,000 على الأكثر، برقمين عشريين.',
  occurredOn: 'يوم المخالفة',
  occurredOnHint: 'خلال آخر 90 يومًا.',
  note: 'ملاحظة للوحدة',
  noteHint: 'اختياري. يقرؤها أفراد الوحدة.',
  photo: 'صورة',
  photoAttached: 'أُرفقت الصورة.',
  addPhoto: 'أضف صورة',
};

export default ar;
