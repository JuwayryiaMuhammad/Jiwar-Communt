import type { Translation } from '@jiwar/i18n';
import type en from '../en/compliance-calendar.ts';

const ar: Translation<typeof en> = {
  title: 'تقويم الامتثال',
  description: 'ما يستحق وأوراق الموردين التي تنتهي، يومًا بيوم.',
  none: 'لا شيء يستحق',
  'col.day': 'اليوم',
  'col.what': 'البند',
  'col.kind': 'النوع',
  'col.state': 'الحالة',
  vendorPaper: '{vendor} · ورقة {kind}',
  truncated: 'أكثر من 1000 بند: اطلب عددًا أقل من الأيام.',
};

export default ar;
