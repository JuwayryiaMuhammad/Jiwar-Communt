import type { Translation } from '@jiwar/i18n';
import type en from '../en/tenants.ts';

const ar: Translation<typeof en> = {
  // The list.
  title: 'المجمعات',
  description: 'كل مجمع مستقل بسكانه وموظفيه وبياناته.',
  newCompound: 'مجمع جديد',
  searchLabel: 'ابحث في المجمعات',
  searchPlaceholder: 'ابحث في المجمعات المعروضة',
  'filter.all': 'الكل',
  'filter.active': 'النشطة',
  'filter.suspended': 'الموقوفة',
  emptyMatch: 'لا يوجد مجمع مطابق',
  empty: 'لا توجد مجمعات بعد',
  'col.name': 'المجمع',
  'col.opened': 'تاريخ الفتح',
  'col.id': 'معرّف المجمع',
  // The new compound's dialog.
  'new.description': 'يفتح مجمعًا مع أول مدير له، وتُنشأ معه الأدوار الافتراضية.',
  'new.submit': 'افتح المجمع',
  'new.name': 'اسم المجمع',
  'new.firstManager': 'أول مدير للمجمع',
  'new.opened': 'فُتح المجمع {name}، ويستطيع مديره تسجيل الدخول ببريده الإلكتروني.',
  // One compound.
  'detail.fallbackTitle': 'المجمع',
  'detail.opened': 'فُتح في {date}',
  'detail.addManager': 'أضف مديرًا',
  'detail.suspend': 'أوقف',
  'detail.reactivate': 'أعد التفعيل',
  'detail.suspended': 'أُوقف المجمع {name}.',
  'detail.reactivated': 'أُعيد تفعيل المجمع {name}.',
  'managers.title': 'مديرو المجمع',
  'managers.body': 'يدير مديرو المجمع شؤونه: السكان والموظفين والبوابات والأدوار.',
  'managers.empty': 'لا يوجد مديرون',
  'managers.erased': 'حساب محذوف',
  'managers.deactivate': 'عطّل',
  'managers.activate': 'فعّل',
  'managers.activated': 'يستطيع {name} تسجيل الدخول مجددًا.',
  'managers.deactivated': 'لم يعد بإمكان {name} تسجيل الدخول.',
  'events.title': 'أحداث الأمان في هذا المجمع',
  'events.noIp': 'بلا عنوان IP',
  'events.empty': 'لا توجد أحداث',
  'state.open': 'مفتوح لتسجيل الدخول',
  'state.suspended': 'موقوف',
  'state.openBody': 'يستطيع السكان والموظفون والمديرون تسجيل الدخول.',
  'state.suspendedBody': 'لا يستطيع أحد في هذا المجمع تسجيل الدخول أو استخدام API حتى يُعاد تفعيله.',
  'facts.managers': 'المديرون',
  'facts.activeManagers':
    '{n, plural, =0 {لا يوجد مدير نشط} one {مدير نشط واحد} two {مديران نشطان} few {# مديرين نشطين} many {# مديرًا نشطًا} other {# مدير نشط}}',
  'history.title': 'السجل',
  'history.empty': 'لا توجد إجراءات للمنصة بعد.',
  // Confirmations.
  'confirm.suspendTitle': 'إيقاف المجمع {name}؟',
  'confirm.reactivateTitle': 'إعادة تفعيل المجمع {name}؟',
  'confirm.suspendBody':
    'يُسجَّل خروج كل من في المجمع عند طلبه التالي، ولا يستطيع تسجيل الدخول حتى تعيد تفعيله. لا تُحذف أي بيانات.',
  'confirm.reactivateBody': 'يستطيع السكان والموظفون والمديرون تسجيل الدخول مجددًا.',
  'confirm.suspendLabel': 'أوقف المجمع',
  'confirm.deactivateTitle': 'تعطيل حساب {name}؟',
  'confirm.activateTitle': 'تفعيل حساب {name}؟',
  'confirm.deactivateBody': 'يُسجَّل خروجه ولا يستطيع تسجيل الدخول، ويبقى للمجمع مديروه الآخرون.',
  'confirm.activateBody': 'يستطيع تسجيل الدخول مجددًا برمز يُرسل إلى بريده الإلكتروني.',
  // The add-manager dialog.
  'add.title': 'أضف مدير مجمع',
  'add.description': 'حساب مدير في المجمع {name}، يسجّل الدخول برمز يُرسل إلى هذا البريد الإلكتروني.',
  'add.submit': 'أضف المدير',
  'add.done': 'أُضيف {name} إلى المجمع {compound}.',
  'add.doneUnnamed': 'أُضيف مدير المجمع إلى {compound}.',
};

export default ar;
