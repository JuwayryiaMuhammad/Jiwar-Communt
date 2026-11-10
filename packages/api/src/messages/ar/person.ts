import type { Translation } from '@jiwar/i18n';
import type en from '../en/person.ts';

const ar: Translation<typeof en> = {
  fullName: 'الاسم الكامل',
  email: 'البريد الإلكتروني',
  emailHint: 'تصل رموز الدخول إلى هذا البريد.',
  phone: 'الهاتف',
  phoneHint: 'مثل 01012345678 أو ‎+44…',
  document: 'وثيقة الهوية',
  nationalId: 'بطاقة الرقم القومي',
  passport: 'جواز السفر',
  passportNumber: 'رقم جواز السفر',
  nationalIdNumber: 'الرقم القومي (14 رقمًا)',
  nationality: 'الجنسية',
  nationalityHint: 'حرفان، مثل GB',
  birthDate: 'تاريخ الميلاد',
  emailLanguage: 'لغة الرسائل',
  arabic: 'العربية',
  english: 'الإنجليزية',
};

export default ar;
