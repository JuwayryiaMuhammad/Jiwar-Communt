import type { Translation } from '@jiwar/i18n';
import type en from '../en/sec-corrective-actions.ts';

const ar: Translation<typeof en> = {
  title: 'الإجراءات التصحيحية',
  added: 'تمت إضافة الإجراء، ويُبلَّغ مسؤوله.',
  markedDone: 'تم تسجيله منفذًا.',
  calledOff: 'تم إلغاؤه.',
  empty: 'لا توجد إجراءات تصحيحية',
  'col.action': 'الإجراء',
  'col.owner': 'المسؤول',
  'col.due': 'الموعد',
  'col.state': 'الحالة',
  erased: 'محذوف',
  dueOverdue: '{date} · متأخر',
  done: 'تم',
  callOff: 'إلغاء',
  whatMustBeDone: 'ما الذي يجب عمله',
  owner: 'المسؤول',
  choose: 'اختر…',
  due: 'الموعد',
  addAction: 'إضافة إجراء',
  callOffTitle: 'إلغاء الإجراء',
};

export default ar;
