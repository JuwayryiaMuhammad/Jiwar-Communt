import type { Translation } from '@jiwar/i18n';
import type en from '../en/services-official-letters.ts';

const ar: Translation<typeof en> = {
  title: 'الخطابات الرسمية',
  description:
    'إفادات الإقامة وخطابات عدم الممانعة وخطابات «إلى من يهمه الأمر». يُطبع على كل خطاب رمز يمكن لأي شخص التحقق منه في الصفحة العامة؛ ولا يُظهر التحقق إلا هل الخطاب ساري، ومن أصدره ومتى.',
  issueLetter: 'أصدر خطابًا',
  issuedToast: 'صدر الخطاب {number}، وأُبلغ صاحبه.',
  revokedToast: 'أُلغي الخطاب {number}، ويظهر ذلك عند التحقق منه.',
  'col.number': 'الرقم',
  'col.kind': 'النوع',
  'col.unit': 'الوحدة',
  'col.for': 'لصالح',
  'col.issued': 'تاريخ الإصدار',
  erased: 'محذوف',
  pdf: 'PDF',
  revoke: 'ألغِ',
  issueDescription:
    'لمالك أو مستأجر له مكان في الوحدة الآن. نص الخطاب يحدده نوعه؛ ويُطبع الاسم والصفة وتاريخ البدء كما هي اليوم.',
  issue: 'أصدر',
  kind: 'النوع',
  unitId: 'معرّف الوحدة',
  accountId: 'معرّف حساب الساكن',
  addressee: 'إلى',
  addresseeHint: 'اختياري: الجهة الموجّه إليها الخطاب.',
  subject: 'بخصوص',
  subjectRequired: 'مطلوب: ما الذي لا مانع منه.',
  optional: 'اختياري.',
  revokeTitle: 'إلغاء {number}؟',
  revokeDescription: 'مرة واحدة فقط. سيُظهر التحقق العام أن الخطاب لم يعد ساريًا.',
};

export default ar;
