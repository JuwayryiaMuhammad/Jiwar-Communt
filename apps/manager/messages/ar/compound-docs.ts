import type { Translation } from '@jiwar/i18n';
import type en from '../en/compound-docs.ts';

const ar: Translation<typeof en> = {
  title: 'مستندات الكمبوند',
  description:
    'ما يقرؤه السكان في التطبيق: اللائحة الداخلية، وحقوقهم، وميثاق السلوك، ودليل الانتقال. كل نسخة جديدة تحفظ النسخ السابقة.',
  'kind.bylaws': 'اللائحة الداخلية',
  'kind.occupant_rights': 'حقوقك',
  'kind.conduct_guide': 'ميثاق السلوك',
  'kind.moving_guide': 'دليل الانتقال',
  'kind.saving_tips': 'نصائح الترشيد',
  'kind.emergency_medical': 'الطوارئ: طبية',
  'kind.emergency_fire': 'الطوارئ: حريق',
  'kind.emergency_security': 'الطوارئ: أمنية',
  'kind.emergency_facilities': 'الطوارئ: مرافق',
  'hint.bylaws': 'يعتمدها مجلس الإدارة: اذكر قراره المنشور.',
  'hint.occupant_rights': 'ما يمكن للساكن الاعتماد عليه، بكلمات بسيطة.',
  'hint.conduct_guide': 'كيف يعيش الجيران معًا.',
  'hint.moving_guide': 'تجديد عقد الإيجار أو الانتقال: معنى كل منهما، والمواعيد، والرسوم.',
  'hint.saving_tips': 'كيف تستهلك الأسرة مياهًا وكهرباءً وغازًا أقل.',
  'hint.emergency_medical': 'ماذا تفعل في حالة طبية طارئة، ومَن تتصل به.',
  'hint.emergency_fire': 'ماذا تفعل عند الحريق: طريق الخروج ونقطة التجمع.',
  'hint.emergency_security': 'ماذا تفعل عند تهديد الأمن.',
  'hint.emergency_facilities': 'تسرب غاز أو فيضان أو انقطاع كهرباء: ما الذي يُغلق ومَن تتصل به.',
  rightsTemplate: `## بيتك
- يحق لك السكن في وحدتك واستخدام المناطق المشتركة التي يفتحها الكمبوند للسكان.
- لا يدخل أحد وحدتك في غيابك، إلا في الطوارئ.

## طلباتك
- يمكنك أن تسأل الإدارة عن أي شيء، وتحصل على رد خلال المدة التي تعلنها.
- يمكنك التظلم من أي قرار يخص وحدتك، أولًا لدى الإدارة ثم لدى مجلس الإدارة.

## أموالك
- ترى كل فاتورة لوحدتك وكل دفعة، ويمكنك الاعتراض على أي فاتورة.
- التأمين الذي تحتفظ به الإدارة ملكٌ لك، ويمكنك طلب استرداده عند المغادرة.`,
  document: 'المستند',
  published: 'المنشور',
  versionLine: 'النسخة {no} · سارية من {date}',
  notPublished: 'لم يُنشر بعد',
  publishAmendment: 'انشر تعديلًا',
  publish: 'انشر',
  publishTitle: 'نشر: {kind}',
  amendTitle: 'تعديل: {kind}',
  publishedToast: 'تم النشر.',
  titleEn: 'العنوان (بالإنجليزية)',
  titleAr: 'العنوان (بالعربية)',
  textEn: 'النص (بالإنجليزية)',
  textAr: 'النص (بالعربية)',
  markdown: 'بصيغة Markdown.',
  changesEn: 'ما الذي يغيّره (بالإنجليزية)',
  changesAr: 'ما الذي يغيّره (بالعربية)',
  inForceFrom: 'سارٍ من',
  boardDecision: 'قرار مجلس الإدارة',
  boardDecisionHint: 'معرّف القرار الذي نشره المجلس (المجلس ← المنشورات).',
  fileAttached: 'تم إرفاق ملف PDF الموقّع — استبدله',
  attachFile: 'أرفق ملف PDF الموقّع (اختياري)',
};

export default ar;
