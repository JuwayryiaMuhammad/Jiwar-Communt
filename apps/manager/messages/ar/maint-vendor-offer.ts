import type { Translation } from '@jiwar/i18n';
import type en from '../en/maint-vendor-offer.ts';

const ar: Translation<typeof en> = {
  title: 'معروض على مورد',
  offer: 'اعرضه على مورد',
  withdraw: 'اسحب العرض',
  none: 'لم يُعرض على مورد.',
  aVendor: 'مورد',
  liveOffer: 'عُرض على {vendor} في {when}. يبقى البلاغ في الطابور وساعة SLA تعمل حتى يقبله أحد المقاولين.',
  offeredAt: 'عُرض في {when}',
  decidedAt: 'رُدّ عليه في {when}',
  endedAt: 'انتهى في {when}',
  cannotListVendors: 'العرض يحتاج صلاحية تقرأ سجل الموردين، كإدارة الموردين أو الأصول.',
  offerTitle: 'عرض {number} على مورد',
  offerDescription:
    'يُبلَّغ مقاولو المورد. يرون العمل وفئته وأولويته ومكانه وملاحظتك، ولا يرون الوحدة ولا الساكن ولا نص البلاغ. أول من يقبله يصير فني البلاغ.',
  vendor: 'المورد',
  vendorHint: 'مورد نشط لديه مقاول يستطيع قبول هذه الفئة.',
  note: 'ملاحظة للمورد',
  noteHint: 'ما يحتاج المورد إلى معرفته قبل أن يقبل. ولا تكتب اسم شخص.',
  offered: 'عُرض {number} على {vendor}.',
  withdrawTitle: 'سحب العرض على {number}؟',
  withdrawDescription: 'لا يرى مقاولو المورد البلاغ بعد الآن، ويبقى في الطابور.',
  withdrawn: 'سُحب العرض على {number}.',
};

export default ar;
