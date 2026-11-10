import type { Translation } from '@jiwar/i18n';
import type en from '../en/logs.ts';

const ar: Translation<typeof en> = {
  // Shared filters and columns.
  'filter.compound': 'المجمع',
  'filter.allCompounds': 'كل المجمعات',
  'filter.reset': 'امسح الفلاتر',
  'col.when': 'الوقت',
  'col.compound': 'المجمع',
  // Security events.
  'events.title': 'أحداث الأمان',
  'events.description':
    'تسجيلات الدخول ورموز التحقق والجلسات في كل المجمعات. تُخزَّن المعرّفات مشفّرة، ولا تُخزَّن أبدًا كبريد إلكتروني أو رقم هاتف.',
  'events.filter': 'الحدث',
  'events.all': 'كل الأحداث',
  'events.emptyMatch': 'لا يوجد حدث يطابق هذه الفلاتر',
  'events.empty': 'لا توجد أحداث أمان بعد',
  'events.col.event': 'الحدث',
  'events.col.subject': 'صاحب الحدث',
  'events.col.ip': 'عنوان IP',
  'events.platform': 'المنصة',
  'subject.account': 'حساب {id}',
  'subject.admin': 'مسؤول {id}',
  'subject.hash': 'معرّف مشفّر {id}',
  // The platform audit log.
  'audit.title': 'سجل تدقيق المنصة',
  'audit.description': 'كل إجراءات المنصة، تُضاف ولا تُعدَّل. لا يمكن تعديل أي إدخال أو حذفه، ولا يحمل أي بيانات شخصية.',
  'audit.filter': 'الإجراء',
  'audit.all': 'كل الإجراءات',
  'audit.emptyMatch': 'لا يوجد إدخال يطابق هذه الفلاتر',
  'audit.empty': 'لا توجد إجراءات للمنصة بعد',
  'audit.col.action': 'الإجراء',
  'audit.col.changes': 'التغييرات',
};

export default ar;
