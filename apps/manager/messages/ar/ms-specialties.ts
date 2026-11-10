import type { Translation } from '@jiwar/i18n';
import type en from '../en/ms-specialties.ts';

const ar: Translation<typeof en> = {
  saved: 'تم حفظ {name}.',
  added: 'تمت إضافة {name}.',
  editTitle: 'تعديل {name}',
  newTitle: 'تخصص جديد',
  newDescription: 'مهارة يملكها الفني وتحتاجها الفئة، مثل السباكة. التوزيع التلقائي يطابق بين الاثنين.',
  saveAndRetire: 'احفظ وأوقف',
  addSpecialty: 'أضف التخصص',
  inUse: 'قيد الاستخدام. إلغاء التحديد يوقفه: لا يُحتسب لأي فئة ولا لأي فني، فيتوقف التوزيع التلقائي عن المطابقة به',
  newSpecialty: 'تخصص جديد',
  empty: 'لا توجد تخصصات بعد',
  emptyHint: 'أضف المهارات التي يملكها فنيوك، ثم أسندها إلى الفنيين (الصيانة، الفنيون) وإلى الفئات.',
  'col.specialty': 'التخصص',
  'col.code': 'الرمز',
  retired: 'موقوف',
};

export default ar;
