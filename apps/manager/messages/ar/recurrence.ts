import type { Translation } from '@jiwar/i18n';
import type en from '../en/recurrence.ts';

const ar: Translation<typeof en> = {
  title: 'الأعطال المتكررة',
  description:
    'إصلاحات فئة واحدة في مكان واحد خلال الفترة، بدءًا من حد المجمع: كم مرة، وكم تباعدت، وكم كلّفت. الأعمال المخططة والبلاغات الملغاة ليست أعطالًا.',
  from: 'من',
  to: 'إلى',
  by: 'حسب',
  empty: 'لم يبلغ أي مكان الحد في هذه الفترة',
  'col.category': 'الفئة',
  'col.tickets': 'البلاغات',
  'col.gap': 'متوسط الفاصل (أيام)',
  'col.cost': 'التكلفة (جنيه)',
  'col.last': 'الأخير',
  'col.months': 'حسب الشهر',
  truncated: 'يُعرض أول 500 صف فقط.',
  takenIn: 'تم ضمّه إلى خطة.',
  dismissed: 'تم الرفض. لن يُقترح مرة أخرى خلال المدة المحددة.',
  suggestionsTitle: 'اقتراحات الخطط',
  suggestionsDescription:
    'تُنشأ عندما تبلغ إصلاحات فئة ما على أصل واحد أو في وحدة واحدة الحد. لا شيء يغيّر الخطة من تلقاء نفسه: ضمّه إلى خطة جديدة أو إلى خطة تغطيه، أو ارفضه.',
  status: 'الحالة',
  anyStatus: 'كل الحالات',
  emptySuggestions: 'لا توجد اقتراحات',
  'col.made': 'تاريخ الإنشاء',
  'col.place': 'المكان',
  'col.faults': 'الأعطال',
  'col.status': 'الحالة',
  placeAsset: 'أصل {code}',
  placeUnit: 'وحدة {code}',
  faultsIn: '{n} خلال {days, plural, one {يوم} two {يومين} few {# أيام} many {# يومًا} other {# يوم}}',
  takeIntoPlan: 'ضمّه إلى خطة',
  dismiss: 'ارفض',
  takeTitle: 'ضمّ إلى خطة',
  takeHint:
    'خطة جديدة بالتقويم على الأصل، أو معرّف خطة نشطة تغطيه بالفعل (تُترك كما هي). اقتراح الوحدة يُنشئ خطة على أصل في منطقة مشتركة تخدمها.',
  existingPlan: 'معرّف خطة قائمة (اختياري)',
  planTitle: 'عنوان الخطة الجديدة',
  every: 'كل',
  unit: 'الوحدة',
  dismissTitle: 'رفض هذا الاقتراح؟',
  dismissDescription: 'لن يُقترح مرة أخرى خلال مدة المجمع المحددة.',
};

export default ar;
