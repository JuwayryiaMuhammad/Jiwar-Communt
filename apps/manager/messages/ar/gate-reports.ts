import type { Translation } from '@jiwar/i18n';
import type en from '../en/gate-reports.ts';

const ar: Translation<typeof en> = {
  exportCsv: 'تصدير CSV',
  everyGate: 'كل البوابات',
  'col.gate': 'البوابة',
  in: 'دخول',
  out: 'خروج',
  'search.title': 'البحث في سجل البوابة',
  'search.description':
    'من دخل ومن خرج، حسب اليوم أو الوحدة أو الاسم الكامل للزائر كما كُتب تمامًا. تُحفظ الأسماء 30 يومًا. يُسجَّل كل بحث دون الاسم.',
  anyUnit: 'أي وحدة',
  visitorName: 'الاسم الكامل للزائر',
  truncated: 'تظهر أحدث 200 حركة فقط: ضيّق الأيام أو صدّرها.',
  'search.empty': 'لا توجد حركة مطابقة',
  'col.when': 'الوقت',
  'col.way': 'الاتجاه',
  'col.who': 'من',
  'col.how': 'الطريقة',
  methodUnconfirmed: '{method} · غير مؤكد',
  'traffic.title': 'حركة البوابة',
  'traffic.description':
    'من دخل يومًا بيوم وبوابة ببوابة: الزائرون حسب طريقة دخولهم، ومركبات الخدمة حسب النوع، ومركبات السكان دخولًا وخروجًا. بحد أقصى 31 يومًا.',
  visitors: 'الزائرون',
  visitorsHint: '{pass} بتصريح · {request} بطلب عند البوابة · {exception} باستثناء',
  serviceVehicles: 'مركبات الخدمة',
  serviceHint:
    '{tanker, plural, =0 {لا صهاريج} one {صهريج واحد} two {صهريجان} few {# صهاريج} many {# صهريجًا} other {# صهريج}} · {waste} نفايات · {delivery, plural, =0 {لا توصيلات} one {توصيلة واحدة} two {توصيلتان} few {# توصيلات} many {# توصيلة} other {# توصيلة}}',
  residentVehicles: 'مركبات السكان',
  residentHint: '{out} خروج',
  'traffic.empty': 'لا توجد بوابة في هذه الفترة',
  'col.day': 'اليوم',
  'col.byPass': 'بتصريح',
  'col.askedAtGate': 'بطلب عند البوابة',
  'col.byException': 'باستثناء',
  'col.residentsIn': 'دخول السكان',
  'col.residentsOut': 'خروج السكان',
};

export default ar;
