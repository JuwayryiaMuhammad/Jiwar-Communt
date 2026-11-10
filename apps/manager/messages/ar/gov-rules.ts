import type { Translation } from '@jiwar/i18n';
import type en from '../en/gov-rules.ts';

const ar: Translation<typeof en> = {
  title: 'قواعد مجلس الإدارة',
  description: 'ما يفحصه النظام بنفسه؛ أما بقية شروط أهلية المرشح فأمرها إليك، بالاستبعاد مع ذكر السبب.',
  candidacies: 'الترشح',
  noDues: 'ارفض ترشح المالك الذي تأخرت وحداته عن السداد بعد موعد الاستحقاق',
  notStaff: 'ارفض ترشح المالك الذي يملك أيضًا حساب موظف أو مدير نشطًا',
  documents: 'مستندات مجلس الإدارة',
  monthly: 'أرسل إلى المجلس تقرير الشهر الماضي في الأيام الأولى من كل شهر',
  hasLogo: 'يتصدر شعار مستندات مجلس الإدارة.',
  noLogo: 'لا يوجد شعار بعد.',
  replaceLogo: 'استبدل الشعار',
  addLogo: 'أضف شعارًا',
  removeLogo: 'أزل الشعار',
};

export default ar;
