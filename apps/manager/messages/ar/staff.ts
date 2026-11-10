import type { Translation } from '@jiwar/i18n';
import type en from '../en/staff.ts';

const ar: Translation<typeof en> = {
  title: 'الموظفون',
  description: 'الحسابات التي تعمل لصالح الكمبوند: المديرون والموظفون مثل الحراس.',
  accountType: 'نوع الحساب',
  staff: 'الموظفون',
  managers: 'المديرون',
  everyone: 'كل الحسابات',
  newAccount: 'حساب جديد',
  emptyStaff: 'لا توجد حسابات موظفين بعد',
  empty: 'لا توجد حسابات',
  erased: 'حساب محذوف',
  you: ' (أنت)',
  since: 'منذ',
  contact: 'التواصل',
  deactivate: 'إيقاف',
  activate: 'تفعيل',
  created: 'تم إنشاء حساب {name}. يسجّل الدخول برمز يصله على بريده الإلكتروني.',
  account: 'حساب',
  canSignIn: 'يستطيع {name} تسجيل الدخول من جديد.',
  cannotSignIn: 'لم يعد {name} يستطيع تسجيل الدخول.',
  deactivateTitle: 'هل تريد إيقاف {name}؟',
  activateTitle: 'هل تريد تفعيل {name}؟',
  deactivateDescription: 'يُسجَّل خروجه عند طلبه التالي ولا يستطيع تسجيل الدخول.',
  activateDescription: 'يستطيع تسجيل الدخول من جديد برمز يصله على بريده الإلكتروني.',
  newTitle: 'حساب موظف جديد',
  newDescription: 'يستخدم الحراس وباقي الموظفين تطبيق جوار؛ أما المدير الآخر فيستخدم لوحة التحكم هذه.',
  createAccount: 'أنشئ الحساب',
  manager: 'مدير',
  role: 'الدور',
  roleHint: 'فارغ: الدور الافتراضي لهذا النوع.',
  defaultRole: 'الافتراضي',
};

export default ar;
