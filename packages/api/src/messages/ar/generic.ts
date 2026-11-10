import type { Translation } from '@jiwar/i18n';
import type en from '../en/generic.ts';

const ar: Translation<typeof en> = {
  requestFailed: 'تعذّر تنفيذ الطلب.',
  somethingWrong: 'حدث خطأ ما.',
  invalidValue: 'قيمة غير صالحة.',
  'length.between': 'من {min} إلى {max} حرفًا.',
  'length.max': 'لا يزيد عن {max} حرفًا.',
  'length.min': 'لا يقل عن {min} حرفًا.',
  'number.between': 'رقم من {min} إلى {max}.',
  'number.max': 'لا يزيد عن {max}.',
  'number.min': 'لا يقل عن {min}.',
  loadMore: 'عرض المزيد',
  fieldsIntro: 'راجع هذه الحقول:',
};

export default ar;
