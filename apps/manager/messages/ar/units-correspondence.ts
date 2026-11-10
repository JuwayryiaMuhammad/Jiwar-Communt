import type { Translation } from '@jiwar/i18n';
import type en from '../en/units-correspondence.ts';

const ar: Translation<typeof en> = {
  title: 'المراسلات',
  description: 'كل ما تبادله سكان الوحدة والإدارة من مراسلات، الأحدث أولًا. يُسجَّل فتح هذه الصفحة في سجل التدقيق.',
  everything: 'الكل',
  'col.when': 'التاريخ',
  'col.what': 'النوع',
  'col.reference': 'الرقم المرجعي',
  fromUnit: 'من الوحدة',
  toUnit: 'إلى الوحدة',
};

export default ar;
