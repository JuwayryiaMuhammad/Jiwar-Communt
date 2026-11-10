import type { Translation } from '@jiwar/i18n';
import type en from '../en/fin-instalments.ts';

const ar: Translation<typeof en> = {
  title: 'خطط التقسيط',
  description: 'فواتير قُسّطت. لتقسيط فاتورة، افتحها واختر «قسّط الفاتورة».',
  shown: 'الخطط المعروضة',
  'view.active': 'نشطة',
  'view.settled': 'مسددة',
  'view.cancelled': 'ملغاة',
  'view.all': 'الكل',
  empty: 'لا توجد خطط',
  'col.plan': 'الخطة',
  'col.invoice': 'الفاتورة',
  'col.instalments': 'الأقساط',
  'col.owed': 'المستحق',
  'col.setUp': 'تاريخ الإنشاء',
  plan: 'خطة تقسيط',
  planTitle: 'الخطة {number}',
  planDescription: 'الوحدة {unit} · من {invoice} · أُنشئت {when}',
  cancelPlan: 'ألغِ الخطة',
  stillOwed: 'المتبقي المستحق',
  cancelledRemainder: 'أُلغيت {when}؛ فاتورة الباقي:',
  instalments: 'الأقساط',
  statement: 'كشف حساب الوحدة',
  noInstalment: 'لا توجد أقساط',
  'col.due': 'تاريخ الاستحقاق',
  'col.paid': 'المدفوع',
  cancelled: 'أُلغيت الخطة. الفاتورة {invoice} تطالب بما كان مستحقًا على الأقساط.',
  cancelledNoNumber: 'أُلغيت الخطة. فاتورة بالباقي تطالب بما كان مستحقًا على الأقساط.',
  cancelTitle: 'إلغاء {number}؟',
  cancelDescription: 'ما بقي مستحقًا على أقساطها ({amount}) يُخصم منها بإشعارات دائنة ويُطالب به من جديد في فاتورة واحدة تُبلَّغ بها الوحدة.',
  keep: 'أبقِ الخطة',
  cancelConfirm: 'ألغِ الخطة',
  remainderDue: 'تاريخ استحقاق الباقي',
};

export default ar;
