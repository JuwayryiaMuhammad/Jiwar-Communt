import type { Translation } from '@jiwar/i18n';
import type en from '../en/work-permits.ts';

const ar: Translation<typeof en> = {
  title: 'تصاريح العمل',
  description: 'الأعمال الساخنة والعمل على ارتفاع والكهرباء الحية والأماكن المغلقة وكيماويات حمام السباحة: لا يبدأ العمل إلا بتصريح ساري.',
  approved: 'تم الاعتماد، ويُبلَّغ الفني.',
  rejected: 'تم الرفض، ويُبلَّغ الفني.',
  revoked: 'تم الإلغاء، ويُبلَّغ الفني بإيقاف ذلك العمل.',
  empty: 'لا توجد تصاريح',
  'col.hazard': 'الخطر',
  'col.ticket': 'البلاغ',
  'col.precautions': 'احتياطات السلامة',
  'col.asked': 'تاريخ الطلب',
  'col.expires': 'ينتهي',
  'col.status': 'الحالة',
  openTicket: 'افتح البلاغ',
  rejectTitle: 'رفض التصريح',
  revokeAction: 'إلغاء التصريح',
  revokeTitle: 'إلغاء التصريح',
};

export default ar;
