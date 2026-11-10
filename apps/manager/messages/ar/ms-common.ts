import type { Translation } from '@jiwar/i18n';
import type en from '../en/ms-common.ts';

const ar: Translation<typeof en> = {
  'duration.d': '{n} يوم',
  'duration.h': '{n} ساعة',
  'duration.m': '{n} دقيقة',
  nameEn: 'الاسم (بالإنجليزية)',
  nameAr: 'الاسم (بالعربية)',
  code: 'الرمز',
  codeHint: 'حروف إنجليزية صغيرة وأرقام وشرطة سفلية، مثل {example}. لا يمكن تغييره بعد ذلك.',
  codeInvalid: 'ابدأ بحرف؛ من 2 إلى 40 حرفًا إنجليزيًا صغيرًا أو رقمًا أو شرطة سفلية.',
};

export default ar;
