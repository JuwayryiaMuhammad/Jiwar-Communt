import type { Translation } from '@jiwar/i18n';
import type en from '../en/units-list.ts';

const ar: Translation<typeof en> = {
  title: 'الوحدات',
  description: 'الشقق والفيلات والمحلات في المجمع.',
  'tab.all': 'كل الوحدات',
  'tab.review': 'قيد المراجعة',
  'tab.buildings': 'المباني',
  import: 'استيراد',
  newUnit: 'وحدة جديدة',
  added: 'أُضيفت الوحدة {code}.',
  code: 'كود الوحدة',
  codeHint: 'كما هو مكتوب على الباب، مثل A-101.',
  addUnit: 'أضف الوحدة',
  searchPlaceholder: 'جزء من كود الوحدة',
  any: 'الكل',
  csv: 'CSV',
  empty: 'لا توجد وحدات مطابقة',
  emptyHint: 'أضف وحدات المجمع ليمكن تسكين السكان فيها.',
  'col.added': 'تاريخ الإضافة',
  reviewEmpty: 'لا توجد وحدة قيد المراجعة',
  reviewEmptyHint: 'تُعلَّم الوحدة للمراجعة عندما يغادر ساكنها الرئيسي أو يُجمَّد حسابه أو يتوفى، أو يُبلَّغ عن انفصال.',
  'col.occupants': 'المقيمون الحاليون',
  'col.flagged': 'دخلت المراجعة',
};

export default ar;
