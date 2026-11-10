import type { Translation } from '@jiwar/i18n';
import type en from '../en/cases.ts';

const ar: Translation<typeof en> = {
  title: 'الحالات المجتمعية',
  description:
    'تُفتح الحالة عندما يبلّغ سكان مبنى عن نوع واحد من الأعطال بعدد كافٍ خلال المدة المحددة (إعداد الصيانة ← مدة الخدمة ← التحليلات). وتبقى بلاغات الصيانة التابعة لها على مسارها.',
  anyStatus: 'أي حالة',
  empty: 'لا توجد حالات',
  opened: 'تاريخ الفتح',
  category: 'الفئة',
  tickets: 'بلاغات الصيانة',
  workOrder: 'أمر العمل',
  case: 'حالة',
  deletedBuilding: 'مبنى محذوف',
  openedOn: 'فُتحت في {when}',
  openedAuto: 'فُتحت تلقائيًا في {when} عند بلوغ الحد',
  resolve: 'تمّ الحل',
  dismiss: 'استبعاد',
  resolved: 'تم الحل. وسيُبلَّغ كل من أبلغ عنها.',
  dismissed: 'تم الاستبعاد.',
  workOrderOpened: 'فُتح أمر العمل الخاص بالحالة.',
  workOrderHint: 'أمر عمل واحد يعالج الحالة كلها، على المنطقة المشتركة التي فيها العطل.',
  commonArea: 'المنطقة المشتركة',
  whatToDo: 'المطلوب تنفيذه',
  openWorkOrder: 'افتح أمر العمل',
  noWorkOrder: 'لا يوجد.',
  ticketsCount: 'بلاغات الصيانة ({count})',
  noTicket: 'لا توجد بلاغات يمكنك رؤيتها',
  ticket: 'البلاغ',
  joined: 'تاريخ الانضمام',
  resolveTitle: 'هل تريد إغلاق هذه الحالة بعد حلها؟',
  resolveDescription: 'سيصل إشعار لكل ساكن أبلغ عن أحد بلاغاتها. وتبقى البلاغات على مسارها.',
  dismissTitle: 'هل تريد استبعاد هذه الحالة؟',
  dismissDescription: 'لن يصل إشعار لأحد. تبقى بلاغاتها داخلها ولا تُحتسب ضمن حالة جديدة.',
};

export default ar;
