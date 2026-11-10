import type { Translation } from '@jiwar/i18n';
import type en from '../en/sec-instructions.ts';

const ar: Translation<typeof en> = {
  title: 'تعليمات للحراس',
  description: 'على كل حارس تصله التعليمات أن يقرّ باستلامها.',
  sent: '{n, plural, =0 {لم تُرسل إلى أي حارس.} one {أُرسلت إلى حارس واحد.} two {أُرسلت إلى حارسين.} few {أُرسلت إلى # حراس.} many {أُرسلت إلى # حارسًا.} other {أُرسلت إلى # حارس.}}',
  newInstruction: 'تعليمات جديدة',
  sendDescription:
    'يقرّ كل حارس تصله بالاستلام. عند بوابة أو منطقة، تصل إلى الحراس هناك وإلى المجدولين فيها هذا الأسبوع، وإلى كل من يبدأ وردية فيها ما دامت سارية.',
  send: 'إرسال',
  titleLabel: 'العنوان',
  instruction: 'التعليمات',
  to: 'إلى',
  allGuards: 'كل الحراس',
  gateOrZone: 'بوابة أو منطقة',
  post: 'الموقع',
  urgentLabel: 'عاجلة: إشعار حرج حتى في ساعات الهدوء',
  archived: 'تمت الأرشفة، ولن تصل إلى أحد جديد.',
  archive: 'أرشفة',
  acknowledgedOf: 'أقرّ {acknowledged} من {recipients} بالاستلام.',
  emptyReached: 'لم تصل إلى أحد بعد',
  guard: 'الحارس',
  reached: 'وصلته',
  whenSent: 'عند الإرسال',
  openingShift: 'عند بدء وردية',
  acknowledged: 'الإقرار بالاستلام',
  notYet: 'ليس بعد',
  shown: 'التعليمات المعروضة',
  'filter.live': 'سارية',
  'filter.archived': 'مؤرشفة',
  empty: 'لا توجد تعليمات',
  urgent: 'عاجلة',
  state: 'الحالة',
  sentCol: 'وقت الإرسال',
};

export default ar;
