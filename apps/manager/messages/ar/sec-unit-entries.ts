import type { Translation } from '@jiwar/i18n';
import type en from '../en/sec-unit-entries.ts';

const ar: Translation<typeof en> = {
  title: 'الدخول الطارئ للوحدات',
  description: 'كل مرة دخل فيها العاملون وحدة دون مالكها: السبب ومن دخل وماذا وجدوا.',
  recordEntry: 'تسجيل دخول',
  show: 'عرض',
  'view.open': 'التقرير مطلوب',
  'view.reported': 'تم التقرير عنها',
  empty: 'لا توجد حالات دخول هنا',
  emptyHint: 'سجّلها فور خروج العاملين من الوحدة.',
  'col.entry': 'الدخول',
  'col.unit': 'الوحدة',
  'col.why': 'السبب',
  'col.wentIn': 'وقت الدخول',
  'col.who': 'من دخل',
  'col.found': 'ما وُجد',
  reportDue: 'التقرير مطلوب',
  report: 'كتابة التقرير',
  // Recording an entry.
  recorded: 'تم تسجيل الدخول، ويُبلَّغ أهل الوحدة الآن. اكتب التقرير بعد الخروج.',
  recordTitle: 'تسجيل دخول طارئ',
  recordDescription: 'دخل العاملون وحدة دون مالكها. يُبلَّغ سكانها ووكيلها فورًا.',
  recordAndTell: 'سجّل وأبلغ أهل الوحدة',
  unitLine: 'الوحدة {code}',
  selectReason: 'اختر السبب…',
  whenWentIn: 'وقت دخول العاملين',
  whenHint: 'خلال آخر أسبوع، واتركه فارغًا للوقت الحالي.',
  witness: 'الشاهد',
  secondWitness: 'شاهد ثانٍ (اختياري)',
  photoBefore: 'صورة قبل الدخول ({n} من 5)',
  // Writing the report.
  reported: 'تمت كتابة التقرير، ويُبلَّغ أهل الوحدة.',
  reportTitle: 'تقرير {reference}',
  reportDescription: 'ما وجده العاملون في {unit} وما فعلوه. يقرؤه أهل الوحدة.',
  writeReport: 'اكتب التقرير',
  whatFound: 'ما الذي وُجد',
  select: 'اختر…',
  whatDid: 'ما فعله العاملون',
  photoAfter: 'صورة بعد الانتهاء ({n} من 5)',
};

export default ar;
