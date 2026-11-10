import type { Translation } from '@jiwar/i18n';
import type en from '../en/complaints-map.ts';

const ar: Translation<typeof en> = {
  title: 'خريطة الشكاوى',
  description:
    'بلاغات الصيانة في وحدات كل مبنى وفي كل منطقة مشتركة خلال المدة، دون الملغاة. لا تظهر هنا وحدة أو بلاغ أو شخص بعينه.',
  emptyBuildings: 'لا توجد مبانٍ في السجل',
  tickets: 'بلاغات الصيانة',
  open: 'مفتوحة',
  fromResidents: 'من السكان',
  most: 'الأكثر',
  position: 'الموقع',
  areasTitle: 'المناطق المشتركة',
  areasDescription: 'بلاغاتها وبلاغات أصولها.',
  emptyAreas: 'لا توجد منطقة مشتركة عليها بلاغ في هذه المدة',
  area: 'المنطقة',
};

export default ar;
