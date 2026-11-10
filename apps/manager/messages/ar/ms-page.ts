import type { Translation } from '@jiwar/i18n';
import type en from '../en/ms-page.ts';

const ar: Translation<typeof en> = {
  title: 'إعداد الصيانة',
  description: 'ما يستطيع الساكنون الإبلاغ عنه وحجزه، ومن يصلحه، ومتى تكون الزيارات، وكيف تُسند البلاغات وتُحدَّد مواعيدها.',
  'tab.categories': 'الفئات',
  'tab.specialties': 'التخصصات',
  'tab.preventive': 'الخدمات الوقائية',
  'tab.rules': 'الساعات والحدود',
  'tab.dispatch': 'التوزيع',
  'tab.sla': 'SLA',
  'tab.asset-types': 'أنواع الأصول',
  'tab.checklists': 'قوائم الفحص',
  'tab.safety': 'السلامة الميدانية',
};

export default ar;
