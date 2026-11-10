import type { Translation } from '@jiwar/i18n';
import type en from '../en/gov-unit-shares.ts';

const ar: Translation<typeof en> = {
  title: 'حصص الملكية',
  saved: 'تم الحفظ. الاستطلاع المفتوح بالفعل يحتفظ بالحصص التي أخذها.',
  weighted: 'للاستطلاعات الموزونة بالحصص.',
  recorded:
    'للاستطلاعات الموزونة بالحصص. المسجَّل: {total} في المجموع؛ و{missing, plural, =0 {لا توجد وحدة مملوكة بلا حصة} one {وحدة مملوكة واحدة بلا حصة ووزنها 0} two {وحدتان مملوكتان بلا حصة ووزنهما 0} few {# وحدات مملوكة بلا حصة ووزنها 0} many {# وحدة مملوكة بلا حصة ووزنها 0} other {# وحدة مملوكة بلا حصة ووزنها 0}}.',
  none: 'لا توجد وحدة مملوكة بعد',
  'col.unit': 'الوحدة',
  'col.share': 'الحصة (%)',
  shareAria: 'حصة الوحدة {unit}',
  placeholder: 'بلا حصة',
};

export default ar;
