import type { Locale } from '../common/i18n/locale';
import type {
  NotificationKind,
  NotificationParams,
} from '../notifications/kinds';

export interface PushText {
  title: string;
  /** `{name}` is replaced by the notification's param of that name. */
  body: string;
}

/**
 * What a push says (ADR 0041), per kind and language. The inbox stores
 * codes and the apps render them (ADR 0013); a push is read on a lock
 * screen before any app runs, so, like an email, its text is written here.
 *
 * Rules, checked by push-texts.spec:
 * - every kind has Arabic and English (a missing kind does not compile);
 * - a placeholder is a param the kind always carries, and never a personal
 *   one: a visitor's or a worker's name stays in the inbox, behind the
 *   phone's lock. The wording is generic instead ("Your worker…");
 * - no code is shown raw (a status, a carrier key): the app shows those.
 */
export const PUSH_TEXTS: Record<NotificationKind, Record<Locale, PushText>> = {
  'gate.approval_requested': {
    en: {
      title: 'Someone is at the gate',
      body: 'Someone is waiting at {gateName} for unit {unitCode}. Open the app to answer.',
    },
    ar: {
      title: 'زائر عند البوابة',
      body: 'يوجد من ينتظر عند {gateName} للوحدة {unitCode}. افتح التطبيق للرد.',
    },
  },
  'gate.approval_reversed': {
    en: {
      title: 'Approval withdrawn',
      body: 'Unit {unitCode} withdrew its approval. Do not let them in.',
    },
    ar: {
      title: 'تم سحب الموافقة',
      body: 'سحبت الوحدة {unitCode} موافقتها. لا تسمح بالدخول.',
    },
  },
  'worker.entered': {
    en: {
      title: 'Your worker has arrived',
      body: 'Your worker entered through {gateName} for unit {unitCode}.',
    },
    ar: {
      title: 'وصل العامل',
      body: 'دخل العامل من {gateName} إلى الوحدة {unitCode}.',
    },
  },
  'worker.exited': {
    en: {
      title: 'Your worker has left',
      body: 'Your worker left through {gateName}.',
    },
    ar: {
      title: 'غادر العامل',
      body: 'خرج العامل من {gateName}.',
    },
  },
  'visitor_pass.not_me': {
    en: {
      title: 'Visitor pass cancelled',
      body: 'The person who received your pass link for unit {unitCode} said it was not for them. The pass was cancelled.',
    },
    ar: {
      title: 'تم إلغاء تصريح الزائر',
      body: 'أفاد مستلم رابط التصريح للوحدة {unitCode} بأنه ليس المقصود، فتم إلغاء التصريح.',
    },
  },
  'entry_credential.issued': {
    en: {
      title: 'New phone registered for entry',
      body: 'A phone was registered for your entry QR. If this was not you, revoke it in the app.',
    },
    ar: {
      title: 'تسجيل هاتف جديد للدخول',
      body: 'تم تسجيل هاتف لرمز الدخول الخاص بك. إذا لم تكن أنت من فعل ذلك، ألغِه من التطبيق.',
    },
  },
  'account.new_device_login': {
    en: {
      title: 'New login to your account',
      body: 'Your account was used on a new device. If this was not you, open the app and report it.',
    },
    ar: {
      title: 'تسجيل دخول جديد إلى حسابك',
      body: 'تم استخدام حسابك على جهاز جديد. إذا لم تكن أنت، افتح التطبيق وأبلغ عن ذلك.',
    },
  },
  'data_export.ready': {
    en: {
      title: 'Your data export is ready',
      body: 'Open the app to download it.',
    },
    ar: {
      title: 'ملف بياناتك جاهز',
      body: 'افتح التطبيق لتنزيله.',
    },
  },
  'household.member_account_deleted': {
    en: {
      title: "A family member's account was deleted",
      body: 'An account in unit {unitCode} was deleted.',
    },
    ar: {
      title: 'تم حذف حساب أحد أفراد الأسرة',
      body: 'تم حذف حساب في الوحدة {unitCode}.',
    },
  },
  'account.deletion_requested': {
    en: {
      title: 'Account deletion requested',
      body: 'Your account is scheduled for deletion. You can cancel this in the app.',
    },
    ar: {
      title: 'طلب حذف الحساب',
      body: 'تمت جدولة حذف حسابك. يمكنك إلغاء الطلب من التطبيق.',
    },
  },
  'account.deletion_reminder': {
    en: {
      title: 'Your account will be deleted soon',
      body: 'Your account will be deleted soon. Open the app if you want to cancel.',
    },
    ar: {
      title: 'سيتم حذف حسابك قريبًا',
      body: 'سيتم حذف حسابك قريبًا. افتح التطبيق إذا أردت إلغاء الطلب.',
    },
  },
  'account.deletion_delayed': {
    en: {
      title: 'Account deletion delayed',
      body: 'Your account could not be deleted yet. Open the app for details.',
    },
    ar: {
      title: 'تأجيل حذف الحساب',
      body: 'تعذّر حذف حسابك الآن. افتح التطبيق لمعرفة التفاصيل.',
    },
  },
  'account.deletion_queued': {
    en: {
      title: 'Deletion request needs review',
      body: 'An account deletion request is waiting in the queue.',
    },
    ar: {
      title: 'طلب حذف بحاجة إلى مراجعة',
      body: 'يوجد طلب حذف حساب في قائمة الانتظار.',
    },
  },
  'contract.expiring': {
    en: {
      title: 'Your lease ends soon',
      body: 'Decide now: renew the lease or plan the move out. Open the app for the dates.',
    },
    ar: {
      title: 'عقد الإيجار يقترب من نهايته',
      body: 'حان وقت القرار: جدّد العقد أو خطّط للإخلاء. افتح التطبيق لمعرفة المواعيد.',
    },
  },
  'contract.renewal_decided': {
    en: {
      title: 'Your renewal request was answered',
      body: 'The management answered your lease renewal request. Open the app to see how.',
    },
    ar: {
      title: 'تم الرد على طلب التجديد',
      body: 'ردّت الإدارة على طلب تجديد عقد الإيجار. افتح التطبيق لمعرفة الرد.',
    },
  },
  'compound_document.published': {
    en: {
      title: 'The compound’s rules changed',
      body: 'A new version of the bylaws or of your rights was published. Open the app to read it.',
    },
    ar: {
      title: 'تحديث في لوائح الكمبوند',
      body: 'نُشر إصدار جديد من اللائحة أو من حقوقك. افتح التطبيق لقراءته.',
    },
  },
  'unit_move.notice_given': {
    en: {
      title: 'Notice to move out',
      body: 'A resident gave notice to move out on {plannedOn}. Open the moves board.',
    },
    ar: {
      title: 'إخطار بالإخلاء',
      body: 'أخطر أحد السكان بالإخلاء يوم {plannedOn}. افتح لوحة الانتقالات.',
    },
  },
  'unit_document.warranty_expiring': {
    en: {
      title: 'A warranty ends soon',
      body: 'A warranty in your unit’s documents ends within 30 days.',
    },
    ar: {
      title: 'ضمان يقترب من نهايته',
      body: 'ينتهي أحد الضمانات في مستندات وحدتك خلال 30 يومًا.',
    },
  },
  'account.identity_change_decided': {
    en: {
      title: 'Your change request was decided',
      body: 'The management decided your name or phone change. Open the app to see how.',
    },
    ar: {
      title: 'تم البت في طلب التعديل',
      body: 'بتّت الإدارة في طلب تعديل الاسم أو الهاتف. افتح التطبيق لتعرف النتيجة.',
    },
  },
  'account.deletion_closed': {
    en: {
      title: 'Deletion request closed',
      body: 'Your account deletion request was closed. Your account was not deleted.',
    },
    ar: {
      title: 'تم إغلاق طلب الحذف',
      body: 'تم إغلاق طلب حذف حسابك، ولم يُحذف الحساب.',
    },
  },
  'account.assisted_action': {
    en: {
      title: 'A change was made to your account',
      body: 'Management made a change for you at your request. Open the app for details.',
    },
    ar: {
      title: 'تم إجراء تغيير على حسابك',
      body: 'أجرت الإدارة تغييرًا بالنيابة عنك بناءً على طلبك. افتح التطبيق لمعرفة التفاصيل.',
    },
  },
  'ticket.emergency': {
    en: {
      title: 'Emergency ticket',
      body: 'Emergency ticket #{ticketNumber} needs attention now.',
    },
    ar: {
      title: 'بلاغ طارئ',
      body: 'البلاغ الطارئ رقم {ticketNumber} يحتاج إلى تدخل فوري.',
    },
  },
  'ticket.assigned': {
    en: {
      title: 'New ticket assigned to you',
      body: 'Ticket #{ticketNumber} is now yours.',
    },
    ar: {
      title: 'بلاغ جديد مسند إليك',
      body: 'تم إسناد البلاغ رقم {ticketNumber} إليك.',
    },
  },
  'ticket.unassigned': {
    en: {
      title: 'Ticket reassigned',
      body: 'Ticket #{ticketNumber} is no longer assigned to you.',
    },
    ar: {
      title: 'تمت إعادة إسناد البلاغ',
      body: 'لم يعد البلاغ رقم {ticketNumber} مسندًا إليك.',
    },
  },
  'ticket.status_changed': {
    en: {
      title: 'Ticket update',
      body: 'Ticket #{ticketNumber} has a new status.',
    },
    ar: {
      title: 'تحديث على البلاغ',
      body: 'تغيّرت حالة البلاغ رقم {ticketNumber}.',
    },
  },
  'ticket.completed': {
    en: {
      title: 'Work completed',
      body: 'Work on ticket #{ticketNumber} is done. Please confirm.',
    },
    ar: {
      title: 'اكتمل العمل',
      body: 'اكتمل العمل على البلاغ رقم {ticketNumber}. يرجى التأكيد.',
    },
  },
  'part_request.created': {
    en: {
      title: 'A part to give out',
      body: 'Ticket #{ticketNumber} asks for {itemRef}.',
    },
    ar: {
      title: 'طلب قطعة',
      body: 'البلاغ رقم {ticketNumber} يطلب {itemRef}.',
    },
  },
  'part_request.reserved': {
    en: {
      title: 'Your part is ready',
      body: 'Ticket #{ticketNumber}: {itemRef} is held for you at the store.',
    },
    ar: {
      title: 'القطعة جاهزة',
      body: 'البلاغ رقم {ticketNumber}: {itemRef} محجوزة لك في المخزن.',
    },
  },
  'part_request.declined': {
    en: {
      title: 'Part not given',
      body: 'Ticket #{ticketNumber}: the store did not give {itemRef}.',
    },
    ar: {
      title: 'لم تُصرف القطعة',
      body: 'البلاغ رقم {ticketNumber}: لم يصرف المخزن {itemRef}.',
    },
  },
  'utility_outage.announced': {
    en: {
      title: 'A utility outage is planned',
      body: 'The {outageKind} supply is cut from {startsAt} to {endsAt}.',
    },
    ar: {
      title: 'انقطاع مرافق مخطط له',
      body: 'تنقطع خدمة {outageKind} من {startsAt} حتى {endsAt}.',
    },
  },
  'utility_outage.rescheduled': {
    en: {
      title: 'An outage has moved',
      body: 'The {outageKind} outage is now from {startsAt} to {endsAt}.',
    },
    ar: {
      title: 'تغيّر موعد انقطاع',
      body: 'أصبح انقطاع {outageKind} من {startsAt} حتى {endsAt}.',
    },
  },
  'utility_outage.ended': {
    en: {
      title: 'The supply is back',
      body: 'The {outageKind} outage has ended.',
    },
    ar: {
      title: 'عادت الخدمة',
      body: 'انتهى انقطاع {outageKind}.',
    },
  },
  'utility_outage.cancelled': {
    en: {
      title: 'An outage is called off',
      body: 'The {outageKind} outage from {startsAt} will not happen.',
    },
    ar: {
      title: 'أُلغي انقطاع',
      body: 'لن يحدث انقطاع {outageKind} المقرر من {startsAt}.',
    },
  },
  'meter.anomaly': {
    en: {
      title: 'A meter ran high',
      body: 'Meter {meterRef} used far more than usual up to {readOn}.',
    },
    ar: {
      title: 'استهلاك مرتفع في عداد',
      body: 'استهلك العداد {meterRef} أكثر من المعتاد بكثير حتى {readOn}.',
    },
  },
  'meter.unit_spike': {
    en: {
      title: 'Your use ran high',
      body: 'Your home used far more {meterKind} than usual up to {readOn}.',
    },
    ar: {
      title: 'استهلاكك مرتفع',
      body: 'استهلك بيتك من {meterKind} أكثر من المعتاد بكثير حتى {readOn}.',
    },
  },
  'maintenance_contract.expiring': {
    en: {
      title: 'A contract ends soon',
      body: 'Contract {contractRef} ends on {endsOn}.',
    },
    ar: {
      title: 'عقد ينتهي قريبًا',
      body: 'ينتهي العقد {contractRef} في {endsOn}.',
    },
  },
  'stock.reorder_level': {
    en: {
      title: 'Time to reorder',
      body: '{itemRef} is at or under its reorder level.',
    },
    ar: {
      title: 'حان وقت إعادة الطلب',
      body: '{itemRef} عند حد إعادة الطلب أو أقل.',
    },
  },
  'ticket.quote_suggested': {
    en: {
      title: 'A quote to send',
      body: 'Ticket #{ticketNumber}: the technician suggests {amount} EGP. Send it to the residents or dismiss it.',
    },
    ar: {
      title: 'عرض سعر مقترح',
      body: 'البلاغ رقم {ticketNumber}: يقترح الفني {amount} جنيه. أرسله إلى السكان أو ارفضه.',
    },
  },
  'ticket.quote_suggestion_dismissed': {
    en: {
      title: 'Suggested quote not sent',
      body: 'Ticket #{ticketNumber}: dispatch did not send the quote you suggested.',
    },
    ar: {
      title: 'لم يُرسل عرض السعر المقترح',
      body: 'البلاغ رقم {ticketNumber}: لم يرسل فريق التوزيع عرض السعر الذي اقترحته.',
    },
  },
  'ticket.quote_proposed': {
    en: {
      title: 'A quote to approve',
      body: 'Ticket #{ticketNumber}: the work will cost {amount} EGP. Approve or decline it before it starts.',
    },
    ar: {
      title: 'عرض سعر بانتظار موافقتك',
      body: 'البلاغ رقم {ticketNumber}: تكلفة العمل {amount} جنيه. وافق عليها أو ارفضها قبل البدء.',
    },
  },
  'ticket.quote_approved': {
    en: {
      title: 'Quote approved',
      body: 'The residents approved the quote of ticket #{ticketNumber}. The work may start.',
    },
    ar: {
      title: 'تمت الموافقة على عرض السعر',
      body: 'وافق السكان على عرض سعر البلاغ رقم {ticketNumber}، ويمكن بدء العمل.',
    },
  },
  'ticket.quote_declined': {
    en: {
      title: 'Quote declined',
      body: 'The residents declined the quote of ticket #{ticketNumber}.',
    },
    ar: {
      title: 'تم رفض عرض السعر',
      body: 'رفض السكان عرض سعر البلاغ رقم {ticketNumber}.',
    },
  },
  'ticket.quote_withdrawn': {
    en: {
      title: 'Quote withdrawn',
      body: 'The quote of ticket #{ticketNumber} was withdrawn.',
    },
    ar: {
      title: 'تم سحب عرض السعر',
      body: 'سُحب عرض سعر البلاغ رقم {ticketNumber}.',
    },
  },
  'ticket.declined': {
    en: {
      title: 'Ticket declined',
      body: 'A technician declined ticket #{ticketNumber}. It is back in the queue.',
    },
    ar: {
      title: 'تم رفض البلاغ',
      body: 'رفض الفني البلاغ رقم {ticketNumber}، وعاد إلى قائمة الانتظار.',
    },
  },
  'ticket.technician_unavailable': {
    en: {
      title: 'Technician unavailable',
      body: 'Ticket #{ticketNumber} is back in the queue: its technician is unavailable.',
    },
    ar: {
      title: 'الفني غير متاح',
      body: 'عاد البلاغ رقم {ticketNumber} إلى قائمة الانتظار لأن الفني غير متاح.',
    },
  },
  'ticket.priority_changed': {
    en: {
      title: 'Ticket priority changed',
      body: 'The priority of ticket #{ticketNumber} was changed.',
    },
    ar: {
      title: 'تغيّرت أولوية البلاغ',
      body: 'تم تغيير أولوية البلاغ رقم {ticketNumber}.',
    },
  },
  'ticket.rejected': {
    en: {
      title: 'Work rejected',
      body: 'The work on ticket #{ticketNumber} was rejected.',
    },
    ar: {
      title: 'تم رفض العمل',
      body: 'تم رفض العمل المنجز في البلاغ رقم {ticketNumber}.',
    },
  },
  'ticket.reopened': {
    en: {
      title: 'Ticket reopened',
      body: 'Ticket #{ticketNumber} was reopened.',
    },
    ar: {
      title: 'أُعيد فتح البلاغ',
      body: 'تمت إعادة فتح البلاغ رقم {ticketNumber}.',
    },
  },
  'ticket.escalated': {
    en: {
      title: 'Ticket needs attention',
      body: 'Ticket #{ticketNumber} was rejected again and needs a review.',
    },
    ar: {
      title: 'بلاغ بحاجة إلى متابعة',
      body: 'رُفض العمل في البلاغ رقم {ticketNumber} مرة أخرى ويحتاج إلى مراجعة.',
    },
  },
  'ticket.auto_closed': {
    en: {
      title: 'Ticket closed',
      body: 'Ticket #{ticketNumber} was closed automatically. You can still reopen it.',
    },
    ar: {
      title: 'تم إغلاق البلاغ',
      body: 'أُغلق البلاغ رقم {ticketNumber} تلقائيًا. يمكنك إعادة فتحه.',
    },
  },
  'ticket.message': {
    en: {
      title: 'New message',
      body: 'There is a new message on ticket #{ticketNumber}.',
    },
    ar: {
      title: 'رسالة جديدة',
      body: 'توجد رسالة جديدة في البلاغ رقم {ticketNumber}.',
    },
  },
  'ticket.opened_on_behalf': {
    en: {
      title: 'A ticket was opened for you',
      body: 'Management opened ticket #{ticketNumber} in your name.',
    },
    ar: {
      title: 'تم فتح بلاغ باسمك',
      body: 'فتحت الإدارة البلاغ رقم {ticketNumber} باسمك.',
    },
  },
  'ticket.unassignable': {
    en: {
      title: 'No technician available',
      body: 'Ticket #{ticketNumber} has no technician who can take it.',
    },
    ar: {
      title: 'لا يوجد فني متاح',
      body: 'لا يوجد فني يمكنه استلام البلاغ رقم {ticketNumber}.',
    },
  },
  'ticket.unassignable_emergency': {
    en: {
      title: 'Emergency without a technician',
      body: 'Emergency ticket #{ticketNumber} has no technician who can take it.',
    },
    ar: {
      title: 'بلاغ طارئ بلا فني',
      body: 'لا يوجد فني يمكنه استلام البلاغ الطارئ رقم {ticketNumber}.',
    },
  },
  'ticket.sla_breached': {
    en: {
      title: 'Ticket overdue',
      body: 'Ticket #{ticketNumber} passed its target time.',
    },
    ar: {
      title: 'بلاغ متأخر',
      body: 'تجاوز البلاغ رقم {ticketNumber} الوقت المستهدف.',
    },
  },
  'ticket.sla_breached_emergency': {
    en: {
      title: 'Emergency ticket overdue',
      body: 'Emergency ticket #{ticketNumber} passed its target time.',
    },
    ar: {
      title: 'بلاغ طارئ متأخر',
      body: 'تجاوز البلاغ الطارئ رقم {ticketNumber} الوقت المستهدف.',
    },
  },
  'ticket.resident_escalated': {
    en: {
      title: 'A resident asked for attention',
      body: 'A resident escalated ticket #{ticketNumber}.',
    },
    ar: {
      title: 'طلب متابعة من ساكن',
      body: 'صعّد أحد السكان البلاغ رقم {ticketNumber}.',
    },
  },
  'ticket.resident_escalated_emergency': {
    en: {
      title: 'Emergency escalated by a resident',
      body: 'A resident escalated emergency ticket #{ticketNumber}.',
    },
    ar: {
      title: 'تصعيد بلاغ طارئ',
      body: 'صعّد أحد السكان البلاغ الطارئ رقم {ticketNumber}.',
    },
  },
  'ticket.visit_proposed': {
    en: {
      title: 'Visit time proposed',
      body: 'A visit time was proposed for ticket #{ticketNumber}. Open the app to answer.',
    },
    ar: {
      title: 'اقتراح موعد زيارة',
      body: 'تم اقتراح موعد زيارة للبلاغ رقم {ticketNumber}. افتح التطبيق للرد.',
    },
  },
  'ticket.visit_confirmed': {
    en: {
      title: 'Visit confirmed',
      body: 'The visit for ticket #{ticketNumber} is confirmed.',
    },
    ar: {
      title: 'تم تأكيد الزيارة',
      body: 'تم تأكيد موعد الزيارة للبلاغ رقم {ticketNumber}.',
    },
  },
  'ticket.visit_cancelled': {
    en: {
      title: 'Visit cancelled',
      body: 'The visit for ticket #{ticketNumber} was cancelled.',
    },
    ar: {
      title: 'تم إلغاء الزيارة',
      body: 'أُلغيت الزيارة الخاصة بالبلاغ رقم {ticketNumber}.',
    },
  },
  'ticket.visit_arrived': {
    en: {
      title: 'The technician has arrived',
      body: 'The technician for ticket #{ticketNumber} is at the door.',
    },
    ar: {
      title: 'وصل الفني',
      body: 'الفني الخاص بالبلاغ رقم {ticketNumber} عند الباب.',
    },
  },
  'ticket.visit_arrival_confirmed': {
    en: {
      title: 'Arrival confirmed',
      body: 'The resident confirmed your arrival for ticket #{ticketNumber}.',
    },
    ar: {
      title: 'تم تأكيد الوصول',
      body: 'أكّد الساكن وصولك للبلاغ رقم {ticketNumber}.',
    },
  },
  'ticket.visit_no_access': {
    en: {
      title: 'The technician could not get in',
      body: 'Nobody let the technician in for ticket #{ticketNumber}. Please choose a new time.',
    },
    ar: {
      title: 'تعذّر دخول الفني',
      body: 'لم يتمكن الفني من الدخول للبلاغ رقم {ticketNumber}. يرجى اختيار موعد جديد.',
    },
  },
  'ticket.visit_late': {
    en: {
      title: 'Visit running late',
      body: 'The technician has not arrived yet for ticket #{ticketNumber}.',
    },
    ar: {
      title: 'تأخر موعد الزيارة',
      body: 'لم يصل الفني بعد للبلاغ رقم {ticketNumber}.',
    },
  },
  'ticket.visit_consent_granted': {
    en: {
      title: 'Entry allowed while nobody is home',
      body: 'Someone in your home allowed the technician in for ticket #{ticketNumber} while nobody is home. You can revoke this in the app.',
    },
    ar: {
      title: 'السماح بالدخول في غيابكم',
      body: 'سمح أحد أفراد منزلك بدخول الفني للبلاغ رقم {ticketNumber} في غياب الجميع. يمكنك إلغاء ذلك من التطبيق.',
    },
  },
  'ticket.category_changed': {
    en: {
      title: 'Ticket category changed',
      body: 'The category of ticket #{ticketNumber} was corrected.',
    },
    ar: {
      title: 'تغيّر تصنيف البلاغ',
      body: 'تم تصحيح تصنيف البلاغ رقم {ticketNumber}.',
    },
  },
  'parcel.arrived': {
    en: {
      title: 'A parcel has arrived',
      body: 'A parcel for unit {unitCode} is at the gate.',
    },
    ar: {
      title: 'وصل طرد',
      body: 'يوجد طرد للوحدة {unitCode} عند البوابة.',
    },
  },
  'parcel.collected': {
    en: {
      title: 'Parcel collected',
      body: 'A parcel for unit {unitCode} was handed over.',
    },
    ar: {
      title: 'تم استلام الطرد',
      body: 'تم تسليم طرد خاص بالوحدة {unitCode}.',
    },
  },
  'parcel.reminder': {
    en: {
      title: 'A parcel is waiting',
      body: 'A parcel for unit {unitCode} is still at the gate. Days waiting: {days}.',
    },
    ar: {
      title: 'طرد بانتظار الاستلام',
      body: 'يوجد طرد للوحدة {unitCode} ما زال عند البوابة. عدد أيام الانتظار: {days}.',
    },
  },
  'parcel.held_long': {
    en: {
      title: 'Parcel held for a long time',
      body: 'Parcel {parcelNumber} for unit {unitCode} is still at the gate. Days waiting: {days}.',
    },
    ar: {
      title: 'طرد محتجز منذ مدة طويلة',
      body: 'الطرد رقم {parcelNumber} للوحدة {unitCode} ما زال عند البوابة. عدد أيام الانتظار: {days}.',
    },
  },
  'parcel.rejected': {
    en: {
      title: 'Parcel refused',
      body: 'The resident refused parcel {parcelNumber}. Please send it back.',
    },
    ar: {
      title: 'تم رفض الطرد',
      body: 'رفض الساكن الطرد رقم {parcelNumber}. يرجى إعادته.',
    },
  },
  'parcel.unclaimable': {
    en: {
      title: 'Parcel with nobody to collect it',
      body: 'Parcel {parcelNumber} arrived for unit {unitCode}, and nobody can collect it.',
    },
    ar: {
      title: 'طرد بلا مستلم',
      body: 'وصل الطرد رقم {parcelNumber} للوحدة {unitCode} ولا يوجد من يمكنه استلامه.',
    },
  },
  // Requests to the management (ADR 0039): the number only.
  'management_request.replied': {
    en: {
      title: 'New reply from management',
      body: 'Management replied to your request #{requestNumber}.',
    },
    ar: {
      title: 'رد جديد من الإدارة',
      body: 'ردّت الإدارة على طلبك رقم {requestNumber}.',
    },
  },
  'management_request.status_changed': {
    en: {
      title: 'Request update',
      body: 'Your request #{requestNumber} has a new status.',
    },
    ar: {
      title: 'تحديث على طلبك',
      body: 'تغيّرت حالة طلبك رقم {requestNumber}.',
    },
  },
  'management_request.auto_closed': {
    en: {
      title: 'Request closed',
      body: 'Your request #{requestNumber} was closed automatically. You can still reopen it.',
    },
    ar: {
      title: 'تم إغلاق الطلب',
      body: 'أُغلق طلبك رقم {requestNumber} تلقائيًا. يمكنك إعادة فتحه.',
    },
  },
  'management_request.opened_for_you': {
    en: {
      title: 'A request was opened for you',
      body: 'Management opened request #{requestNumber} in your name.',
    },
    ar: {
      title: 'تم فتح طلب باسمك',
      body: 'فتحت الإدارة الطلب رقم {requestNumber} باسمك.',
    },
  },
  'management_appointment.proposed': {
    en: {
      title: 'Appointment proposed',
      body: 'Management proposed a time for request #{requestNumber}. Open the app to answer.',
    },
    ar: {
      title: 'اقتراح موعد',
      body: 'اقترحت الإدارة موعدًا للطلب رقم {requestNumber}. افتح التطبيق للرد.',
    },
  },
  'management_appointment.countered': {
    en: {
      title: 'Another time proposed',
      body: 'Management proposed another time for request #{requestNumber}. Open the app to answer.',
    },
    ar: {
      title: 'اقتراح موعد آخر',
      body: 'اقترحت الإدارة موعدًا آخر للطلب رقم {requestNumber}. افتح التطبيق للرد.',
    },
  },
  'management_appointment.confirmed': {
    en: {
      title: 'Appointment confirmed',
      body: 'Your appointment for request #{requestNumber} is confirmed.',
    },
    ar: {
      title: 'تم تأكيد الموعد',
      body: 'تم تأكيد موعدك الخاص بالطلب رقم {requestNumber}.',
    },
  },
  'management_appointment.cancelled': {
    en: {
      title: 'Appointment cancelled',
      body: 'Management cancelled your appointment for request #{requestNumber}.',
    },
    ar: {
      title: 'تم إلغاء الموعد',
      body: 'ألغت الإدارة موعدك الخاص بالطلب رقم {requestNumber}.',
    },
  },
  'management_request.created': {
    en: {
      title: 'New request',
      body: 'Request #{requestNumber} was received.',
    },
    ar: {
      title: 'طلب جديد',
      body: 'تم استلام الطلب رقم {requestNumber}.',
    },
  },
  'management_request.assigned': {
    en: {
      title: 'Request assigned to you',
      body: 'Request #{requestNumber} is now yours.',
    },
    ar: {
      title: 'طلب مسند إليك',
      body: 'تم إسناد الطلب رقم {requestNumber} إليك.',
    },
  },
  'management_request.escalated': {
    en: {
      title: 'Request overdue',
      body: 'Request #{requestNumber} is still waiting for a response.',
    },
    ar: {
      title: 'طلب متأخر',
      body: 'الطلب رقم {requestNumber} ما زال بانتظار الرد.',
    },
  },
  'management_request.resident_replied': {
    en: {
      title: 'New reply on a request',
      body: 'The resident wrote on request #{requestNumber}.',
    },
    ar: {
      title: 'رد جديد على طلب',
      body: 'كتب الساكن ردًا على الطلب رقم {requestNumber}.',
    },
  },
  'management_request.reopened': {
    en: {
      title: 'Request reopened',
      body: 'The resident reopened request #{requestNumber}.',
    },
    ar: {
      title: 'أُعيد فتح الطلب',
      body: 'أعاد الساكن فتح الطلب رقم {requestNumber}.',
    },
  },
  'management_request.withdrawn': {
    en: {
      title: 'Request withdrawn',
      body: 'The resident withdrew request #{requestNumber}.',
    },
    ar: {
      title: 'تم سحب الطلب',
      body: 'سحب الساكن الطلب رقم {requestNumber}.',
    },
  },
  'management_appointment.requested': {
    en: {
      title: 'Appointment requested',
      body: 'The resident picked a time for request #{requestNumber}.',
    },
    ar: {
      title: 'طلب موعد',
      body: 'اختار الساكن موعدًا للطلب رقم {requestNumber}.',
    },
  },
  'management_appointment.accepted': {
    en: {
      title: 'Appointment accepted',
      body: 'The resident accepted the proposed time for request #{requestNumber}.',
    },
    ar: {
      title: 'تم قبول الموعد',
      body: 'قبل الساكن الموعد المقترح للطلب رقم {requestNumber}.',
    },
  },
  'management_appointment.cancelled_by_resident': {
    en: {
      title: 'Appointment cancelled by the resident',
      body: 'The resident cancelled the appointment for request #{requestNumber}.',
    },
    ar: {
      title: 'ألغى الساكن الموعد',
      body: 'ألغى الساكن الموعد الخاص بالطلب رقم {requestNumber}.',
    },
  },
  // Community life (ADR 0040): what happened, never a word anyone wrote.
  'community_announcement.important': {
    en: {
      title: 'Important announcement',
      body: 'The management published an important announcement. Open the app to read it.',
    },
    ar: {
      title: 'إعلان مهم',
      body: 'نشرت الإدارة إعلاناً مهماً. افتح التطبيق لقراءته.',
    },
  },
  'community_event.cancelled': {
    en: {
      title: 'Event cancelled',
      body: 'An event you said you are going to was cancelled. Open the app for details.',
    },
    ar: {
      title: 'تم إلغاء فعالية',
      body: 'أُلغيت فعالية كنت قد أكدت حضورها. افتح التطبيق للتفاصيل.',
    },
  },
  'community_suggestion.status_changed': {
    en: {
      title: 'News about your suggestion',
      body: 'The management updated your suggestion. Open the app to see where it stands.',
    },
    ar: {
      title: 'جديد بخصوص اقتراحك',
      body: 'حدّثت الإدارة اقتراحك. افتح التطبيق لمعرفة ما وصل إليه.',
    },
  },
  // Neighbours (ADR 0042): a complaint's number only, never a unit or a name.
  'neighbour_complaint.submitted': {
    en: {
      title: 'New complaint between units',
      body: 'Complaint #{complaintNumber} was filed and is waiting for review.',
    },
    ar: {
      title: 'شكوى جديدة بين الوحدات',
      body: 'تم تقديم الشكوى رقم {complaintNumber} وهي بانتظار المراجعة.',
    },
  },
  'neighbour_complaint.author_replied': {
    en: {
      title: 'New message on a complaint',
      body: 'The resident wrote on complaint #{complaintNumber}.',
    },
    ar: {
      title: 'رسالة جديدة على شكوى',
      body: 'كتب الساكن على الشكوى رقم {complaintNumber}.',
    },
  },
  'neighbour_complaint.withdrawn': {
    en: {
      title: 'Complaint withdrawn',
      body: 'Complaint #{complaintNumber} was withdrawn by the resident.',
    },
    ar: {
      title: 'تم سحب شكوى',
      body: 'سحب الساكن الشكوى رقم {complaintNumber}.',
    },
  },
  'neighbour_complaint.under_review': {
    en: {
      title: 'Complaint under review',
      body: 'Management is reviewing your complaint #{complaintNumber}.',
    },
    ar: {
      title: 'الشكوى قيد المراجعة',
      body: 'تراجع الإدارة شكواك رقم {complaintNumber}.',
    },
  },
  'neighbour_complaint.in_mediation': {
    en: {
      title: 'Complaint in mediation',
      body: 'Management is mediating your complaint #{complaintNumber}.',
    },
    ar: {
      title: 'الشكوى قيد الوساطة',
      body: 'تتوسط الإدارة في شكواك رقم {complaintNumber}.',
    },
  },
  'neighbour_complaint.resolved': {
    en: {
      title: 'Complaint resolved',
      body: 'Your complaint #{complaintNumber} was resolved.',
    },
    ar: {
      title: 'تم حل الشكوى',
      body: 'تم حل شكواك رقم {complaintNumber}.',
    },
  },
  'neighbour_complaint.dismissed': {
    en: {
      title: 'Complaint closed',
      body: 'Management closed your complaint #{complaintNumber}. Open the app for details.',
    },
    ar: {
      title: 'تم إغلاق الشكوى',
      body: 'أغلقت الإدارة شكواك رقم {complaintNumber}. افتح التطبيق للتفاصيل.',
    },
  },
  'neighbour_complaint.replied': {
    en: {
      title: 'New reply from management',
      body: 'Management replied on your complaint #{complaintNumber}.',
    },
    ar: {
      title: 'رد جديد من الإدارة',
      body: 'ردّت الإدارة على شكواك رقم {complaintNumber}.',
    },
  },
  'neighbour_complaint.notice_sent': {
    en: {
      title: 'Notice sent',
      body: 'Management sent a notice about your complaint #{complaintNumber}.',
    },
    ar: {
      title: 'تم إرسال إشعار',
      body: 'أرسلت الإدارة إشعارًا بخصوص شكواك رقم {complaintNumber}.',
    },
  },
  'neighbour_notice.unit_replied': {
    en: {
      title: 'A unit answered its notice',
      body: 'The unit answered the notice on complaint #{complaintNumber}.',
    },
    ar: {
      title: 'رد من وحدة على إشعار',
      body: 'ردّت الوحدة على الإشعار الخاص بالشكوى رقم {complaintNumber}.',
    },
  },
  // To the unit: nothing of the complaint, not even its number.
  'neighbour_notice.received': {
    en: {
      title: 'Notice from management',
      body: 'Management sent your unit a notice. Open the app to read it.',
    },
    ar: {
      title: 'إشعار من الإدارة',
      body: 'أرسلت الإدارة إشعارًا إلى وحدتك. افتح التطبيق لقراءته.',
    },
  },
  'neighbour_notice.replied': {
    en: {
      title: 'New message from management',
      body: 'Management wrote to your unit about a notice. Open the app to read it.',
    },
    ar: {
      title: 'رسالة جديدة من الإدارة',
      body: 'كتبت الإدارة إلى وحدتك بخصوص إشعار. افتح التطبيق لقراءتها.',
    },
  },
  // The boards: nothing of a post's words.
  'neighbour_item.claimed': {
    en: {
      title: 'Found item claimed',
      body: 'A resident claimed a found item. Open the desk to review it.',
    },
    ar: {
      title: 'مطالبة بغرض معثور عليه',
      body: 'طالب أحد السكان بغرض معثور عليه. افتح المكتب لمراجعتها.',
    },
  },
  'neighbour_item.handed_over': {
    en: {
      title: 'Item handed over',
      body: 'The management office recorded that your item was handed to you.',
    },
    ar: {
      title: 'تم تسليم الغرض',
      body: 'سجّل مكتب الإدارة تسليم الغرض إليك.',
    },
  },
  'neighbour_claim.declined': {
    en: {
      title: 'Claim closed',
      body: 'Your claim on a found item was closed. Open the app for details.',
    },
    ar: {
      title: 'تم إغلاق المطالبة',
      body: 'أُغلقت مطالبتك بغرض معثور عليه. افتح التطبيق للتفاصيل.',
    },
  },
  'neighbour_post.removed': {
    en: {
      title: 'Post removed',
      body: 'Management removed one of your posts from the board.',
    },
    ar: {
      title: 'تمت إزالة منشور',
      body: 'أزالت الإدارة أحد منشوراتك من اللوحة.',
    },
  },
  // Masked contact: no name, no building, no word of a message.
  'neighbour_conversation.started': {
    en: {
      title: 'A neighbour wrote to you',
      body: 'A neighbour wrote to you about one of your posts.',
    },
    ar: {
      title: 'رسالة من أحد الجيران',
      body: 'كتب إليك أحد الجيران بخصوص أحد منشوراتك.',
    },
  },
  'neighbour_conversation.message': {
    en: {
      title: 'New message from a neighbour',
      body: 'You have a new message in a conversation about a post.',
    },
    ar: {
      title: 'رسالة جديدة من أحد الجيران',
      body: 'لديك رسالة جديدة في محادثة بخصوص منشور.',
    },
  },
  'neighbour_conversation.reveal_requested': {
    en: {
      title: 'A neighbour wants to share names',
      body: 'A neighbour agreed to share first names. Names show only if you agree too.',
    },
    ar: {
      title: 'أحد الجيران يود تبادل الأسماء',
      body: 'وافق أحد الجيران على إظهار الاسم الأول. لن تظهر الأسماء إلا بموافقتك أيضًا.',
    },
  },
  'neighbour_conversation.names_revealed': {
    en: {
      title: 'Names are now shown',
      body: 'You and your neighbour both agreed. First names now show in the conversation.',
    },
    ar: {
      title: 'الأسماء ظاهرة الآن',
      body: 'وافقتما معًا. يظهر الاسم الأول الآن في المحادثة.',
    },
  },
  'neighbour_conversation.reported': {
    en: {
      title: 'Conversation reported',
      body: 'A resident reported a conversation. Open the case to review it.',
    },
    ar: {
      title: 'بلاغ عن محادثة',
      body: 'أبلغ أحد السكان عن محادثة. افتح البلاغ لمراجعته.',
    },
  },
  'neighbour_report.closed': {
    en: {
      title: 'Your report was reviewed',
      body: 'Management reviewed the conversation you reported.',
    },
    ar: {
      title: 'تمت مراجعة بلاغك',
      body: 'راجعت الإدارة المحادثة التي أبلغت عنها.',
    },
  },
  'neighbours.welcome': {
    en: {
      title: 'Welcome to the compound',
      body: 'Welcome. Open the app for the compound rules, office hours and emergency numbers.',
    },
    ar: {
      title: 'مرحبًا بك في المجمع',
      body: 'مرحبًا بك. افتح التطبيق للاطلاع على قواعد المجمع ومواعيد المكتب وأرقام الطوارئ.',
    },
  },
  // Bookings and the club (ADR 0044): generic, no facility, time or name;
  // the app shows the booking and its reason.
  'booking.approved': {
    en: {
      title: 'Booking confirmed',
      body: 'The management approved your booking.',
    },
    ar: {
      title: 'تم تأكيد الحجز',
      body: 'وافقت الإدارة على حجزك.',
    },
  },
  'booking.rejected': {
    en: {
      title: 'Booking not approved',
      body: 'Your booking request was not approved. Open the app for details.',
    },
    ar: {
      title: 'لم تتم الموافقة على الحجز',
      body: 'لم تتم الموافقة على طلب حجزك. افتح التطبيق للتفاصيل.',
    },
  },
  'booking.approval_expired': {
    en: {
      title: 'Booking request expired',
      body: 'Your booking request was not approved in time.',
    },
    ar: {
      title: 'انتهت مهلة طلب الحجز',
      body: 'لم تتم الموافقة على طلب حجزك في الوقت المحدد.',
    },
  },
  'booking.cancelled_by_staff': {
    en: {
      title: 'Booking cancelled',
      body: 'The management cancelled your booking.',
    },
    ar: {
      title: 'تم إلغاء الحجز',
      body: 'ألغت الإدارة حجزك.',
    },
  },
  'booking.cancelled_by_closure': {
    en: {
      title: 'Booking cancelled',
      body: 'Your booking was cancelled because the facility is closed at that time.',
    },
    ar: {
      title: 'تم إلغاء الحجز',
      body: 'أُلغي حجزك لأن المرفق مغلق في ذلك الوقت.',
    },
  },
  'booking_suspension.started': {
    en: {
      title: 'Bookings paused',
      body: 'Your unit cannot make new bookings for a while. Open the app for the end date.',
    },
    ar: {
      title: 'إيقاف الحجوزات مؤقتاً',
      body: 'لا يمكن لوحدتك إجراء حجوزات جديدة لفترة. افتح التطبيق لمعرفة تاريخ الانتهاء.',
    },
  },
  'facility_ban.started': {
    en: {
      title: 'Bookings stopped',
      body: 'The management stopped you booking for a while. Open the app for which facilities and until when.',
    },
    ar: {
      title: 'إيقاف الحجز',
      body: 'أوقفت الإدارة حجوزاتك لفترة. افتح التطبيق لمعرفة المرافق وتاريخ الانتهاء.',
    },
  },
  'facility_ban.lifted': {
    en: {
      title: 'Bookings open again',
      body: 'The management lifted the stop on your bookings.',
    },
    ar: {
      title: 'عودة الحجز',
      body: 'رفعت الإدارة إيقاف حجوزاتك.',
    },
  },
  'booking.reminder': {
    en: {
      title: 'Booking soon',
      body: 'Your facility booking starts in about two hours.',
    },
    ar: {
      title: 'حجزك قريب',
      body: 'يبدأ حجزك للمرفق بعد ساعتين تقريباً.',
    },
  },
  'club_membership.expiring': {
    en: {
      title: 'Membership ends soon',
      body: 'Your club membership ends within a week.',
    },
    ar: {
      title: 'اشتراك النادي ينتهي قريباً',
      body: 'ينتهي اشتراكك في النادي خلال أسبوع.',
    },
  },
  'vehicle.approved': {
    en: {
      title: 'Vehicle approved',
      body: 'Your vehicle’s parking permit is now active.',
    },
    ar: {
      title: 'تمت الموافقة على المركبة',
      body: 'أصبح تصريح ركن مركبتك ساريًا.',
    },
  },
  'vehicle.rejected': {
    en: {
      title: 'Vehicle not approved',
      body: 'Your vehicle registration was not approved. Open the app to see why.',
    },
    ar: {
      title: 'لم تتم الموافقة على المركبة',
      body: 'لم تتم الموافقة على تسجيل مركبتك. افتح التطبيق لمعرفة السبب.',
    },
  },
  'vehicle.permit_expiring': {
    en: {
      title: 'Parking permit expiring',
      body: 'A vehicle’s parking permit expires within 30 days. Contact the management office to renew it.',
    },
    ar: {
      title: 'تصريح الركن قارب على الانتهاء',
      body: 'ينتهي تصريح ركن إحدى المركبات خلال 30 يومًا. تواصل مع مكتب الإدارة لتجديده.',
    },
  },
  'vehicle.registrant_left': {
    en: {
      title: 'Vehicle removed',
      body: 'A vehicle registered to your unit was removed because its owner no longer lives there. Register it again if it stays.',
    },
    ar: {
      title: 'تمت إزالة مركبة',
      body: 'أُزيلت مركبة مسجلة على وحدتك لأن صاحبها لم يعد يقيم فيها. سجّلها من جديد إن كانت ستبقى.',
    },
  },
  'vehicle_fine.issued': {
    en: {
      title: 'New parking fine',
      body: 'A parking fine was issued to your unit. Open the app for details.',
    },
    ar: {
      title: 'مخالفة ركن جديدة',
      body: 'صدرت مخالفة ركن على وحدتك. افتح التطبيق لمعرفة التفاصيل.',
    },
  },
  'vehicle_fine.appeal_upheld': {
    en: {
      title: 'Appeal decided',
      body: 'Your appeal was reviewed and the fine stands. It can be paid at the management office.',
    },
    ar: {
      title: 'تم البت في التظلم',
      body: 'تمت مراجعة تظلمك وتأييد المخالفة. يمكن سدادها في مكتب الإدارة.',
    },
  },
  'vehicle_fine.appeal_accepted': {
    en: {
      title: 'Appeal accepted',
      body: 'Your appeal was accepted and the fine was cancelled.',
    },
    ar: {
      title: 'تم قبول التظلم',
      body: 'تم قبول تظلمك وإلغاء المخالفة.',
    },
  },
  'emergency.reported': {
    en: {
      title: 'Emergency reported',
      body: 'An emergency was reported. Open the app now to respond.',
    },
    ar: {
      title: 'بلاغ طوارئ',
      body: 'تم الإبلاغ عن حالة طارئة. افتح التطبيق الآن للاستجابة.',
    },
  },
  'emergency.family_alert': {
    en: {
      title: 'Emergency',
      body: 'Emergency reported from your unit',
    },
    ar: {
      title: 'حالة طارئة',
      body: 'تم الإبلاغ عن حالة طارئة من وحدتك',
    },
  },
  'emergency.escalated': {
    en: {
      title: 'Emergency without a responder',
      body: 'Nobody has answered an emergency yet. Open the app now.',
    },
    ar: {
      title: 'بلاغ طوارئ بلا استجابة',
      body: 'لم يستجب أحد لبلاغ طوارئ حتى الآن. افتح التطبيق الآن.',
    },
  },
  'emergency.responder_on_the_way': {
    en: {
      title: 'Security is on the way',
      body: 'A responder is on the way, about {etaMinutes} minutes.',
    },
    ar: {
      title: 'الأمن في الطريق',
      body: 'أحد المستجيبين في الطريق، خلال {etaMinutes} دقائق تقريبًا.',
    },
  },
  'permit_inspection.requested': {
    en: {
      title: 'Finished works to inspect',
      body: 'A unit asks for its finished works to be inspected (round {cycle}).',
    },
    ar: {
      title: 'أعمال منتهية للمعاينة',
      body: 'تطلب إحدى الوحدات معاينة أعمالها المنتهية (المرة {cycle}).',
    },
  },
  'permit_inspection.decided': {
    en: {
      title: 'Your works were inspected',
      body: 'The management inspected your finished works. The result is in the app.',
    },
    ar: {
      title: 'تمت معاينة أعمالك',
      body: 'عاينت الإدارة أعمالك المنتهية. النتيجة في التطبيق.',
    },
  },
  'unit_permit.requested': {
    en: {
      title: 'New permit to decide',
      body: 'A unit asked for a permit. Open the dashboard to decide.',
    },
    ar: {
      title: 'تصريح جديد للمراجعة',
      body: 'طلبت إحدى الوحدات تصريحًا. افتح لوحة التحكم للبت فيه.',
    },
  },
  'unit_permit.approved': {
    en: {
      title: 'Permit approved',
      body: 'The management approved your permit. Open the app to see it.',
    },
    ar: {
      title: 'تمت الموافقة على التصريح',
      body: 'وافقت الإدارة على تصريحك. افتح التطبيق لعرضه.',
    },
  },
  'unit_permit.rejected': {
    en: {
      title: 'Permit not approved',
      body: 'The management did not approve your permit. Open the app to see why.',
    },
    ar: {
      title: 'لم تتم الموافقة على التصريح',
      body: 'لم توافق الإدارة على تصريحك. افتح التطبيق لمعرفة السبب.',
    },
  },
  'unit_permit.revoked': {
    en: {
      title: 'Permit revoked',
      body: 'The management revoked your permit. Open the app to see why.',
    },
    ar: {
      title: 'تم إلغاء التصريح',
      body: 'ألغت الإدارة تصريحك. افتح التطبيق لمعرفة السبب.',
    },
  },
  'unit_permit.used': {
    en: {
      title: 'Goods went out',
      body: 'The goods on your unit’s permit went out at the gate.',
    },
    ar: {
      title: 'خرجت المواد',
      body: 'خرجت المواد المذكورة في تصريح وحدتك من البوابة.',
    },
  },
  'unit_permit.cancelled': {
    en: {
      title: 'Permit cancelled',
      body: 'A permit of your unit was cancelled. Open the app to see why.',
    },
    ar: {
      title: 'تم إلغاء تصريح',
      body: 'تم إلغاء تصريح لوحدتك. افتح التطبيق لمعرفة السبب.',
    },
  },
  'gate_service.requested': {
    en: {
      title: 'New request for security',
      body: 'A resident asked for help from security. Open the app to answer.',
    },
    ar: {
      title: 'طلب جديد للأمن',
      body: 'طلب أحد السكان مساعدة من الأمن. افتح التطبيق للرد.',
    },
  },
  'gate_service.accepted': {
    en: {
      title: 'Security accepted your request',
      body: 'Security accepted your request and is on it.',
    },
    ar: {
      title: 'قبل الأمن طلبك',
      body: 'قبل الأمن طلبك ويعمل عليه.',
    },
  },
  'gate_service.closed': {
    en: {
      title: 'Request closed',
      body: 'Security closed your request. The details are in the app.',
    },
    ar: {
      title: 'تم إغلاق الطلب',
      body: 'أغلق الأمن طلبك. التفاصيل في التطبيق.',
    },
  },
  'emergency.cancelled': {
    en: {
      title: 'Emergency cancelled',
      body: 'The household cancelled the emergency. You can stand down.',
    },
    ar: {
      title: 'تم إلغاء بلاغ الطوارئ',
      body: 'ألغت الوحدة بلاغ الطوارئ. لا حاجة للتحرك.',
    },
  },
  'emergency.cancel_requested': {
    en: {
      title: 'SOS: asked to stand down',
      body: 'Who raised the SOS asked to call it off. It stays open: check on them, then resolve it.',
    },
    ar: {
      title: 'طلب إلغاء استغاثة',
      body: 'طلب صاحب الاستغاثة إلغاءها. تظل مفتوحة: اطمئن عليه ثم أغلقها.',
    },
  },
  'invoice.issued': {
    en: {
      title: 'New invoice',
      body: 'A new invoice was issued for your unit. Open the app for details.',
    },
    ar: {
      title: 'فاتورة جديدة',
      body: 'صدرت فاتورة جديدة لوحدتك. افتح التطبيق لمعرفة التفاصيل.',
    },
  },
  'invoice.due_soon': {
    en: {
      title: 'Invoice due soon',
      body: 'An invoice for your unit is due in a few days.',
    },
    ar: {
      title: 'فاتورة مستحقة قريبًا',
      body: 'تستحق فاتورة لوحدتك خلال أيام.',
    },
  },
  'invoice.overdue': {
    en: {
      title: 'Invoice overdue',
      body: 'An invoice for your unit is past its due date.',
    },
    ar: {
      title: 'فاتورة متأخرة',
      body: 'تجاوزت فاتورة لوحدتك تاريخ استحقاقها.',
    },
  },
  'payment.received': {
    en: {
      title: 'Payment received',
      body: 'A payment for your unit was received. Your receipt is in the app.',
    },
    ar: {
      title: 'تم استلام دفعة',
      body: 'تم استلام دفعة لوحدتك. الإيصال متاح في التطبيق.',
    },
  },
  'instalment_plan_request.submitted': {
    en: {
      title: 'A payment plan was asked for',
      body: 'A resident asked for a payment plan on an invoice.',
    },
    ar: {
      title: 'طلب خطة سداد',
      body: 'طلب ساكن خطة سداد على فاتورة.',
    },
  },
  'instalment_plan_request.accepted': {
    en: {
      title: 'Your payment plan was accepted',
      body: 'The management set your instalments. They are in the app.',
    },
    ar: {
      title: 'قُبلت خطة السداد',
      body: 'حددت الإدارة أقساطك، وهي متاحة في التطبيق.',
    },
  },
  'instalment_plan_request.declined': {
    en: {
      title: 'Your payment plan was not accepted',
      body: 'The management declined your payment plan request.',
    },
    ar: {
      title: 'لم تُقبل خطة السداد',
      body: 'رفضت الإدارة طلب خطة السداد.',
    },
  },
  'invoice.plan_available': {
    en: {
      title: 'You may pay in instalments',
      body: 'An invoice due soon may be paid by a plan. Ask for one in the app.',
    },
    ar: {
      title: 'يمكنك السداد بالتقسيط',
      body: 'فاتورة يقترب موعدها يمكن سدادها بخطة. اطلبها من التطبيق.',
    },
  },
  'finance.dues_rising': {
    en: {
      title: 'Next month asks more',
      body: 'Your unit’s dues for {month} are well above the months before. See them in the app.',
    },
    ar: {
      title: 'مستحقات الشهر القادم أعلى',
      body: 'مستحقات وحدتك عن {month} أعلى بكثير من الأشهر السابقة. اطّلع عليها في التطبيق.',
    },
  },
  'collector_visit.requested': {
    en: {
      title: 'A collector visit was asked for',
      body: 'A resident asked for a collector to take cash at their unit.',
    },
    ar: {
      title: 'طلب زيارة محصّل',
      body: 'طلب ساكن زيارة محصّل لتحصيل مبلغ نقدي من وحدته.',
    },
  },
  'collector_visit.assigned': {
    en: {
      title: 'A visit is yours',
      body: 'A collection visit from {windowStartsAt} to {windowEndsAt} was given to you.',
    },
    ar: {
      title: 'زيارة جديدة لك',
      body: 'أُسندت إليك زيارة تحصيل من {windowStartsAt} حتى {windowEndsAt}.',
    },
  },
  'collector_visit.cancelled': {
    en: {
      title: 'A visit was called off',
      body: 'One of your collection visits was called off.',
    },
    ar: {
      title: 'أُلغيت زيارة',
      body: 'أُلغيت إحدى زيارات التحصيل الخاصة بك.',
    },
  },
  'collector_visit.scheduled': {
    en: {
      title: 'A collector will come',
      body: 'A collector will come between {windowStartsAt} and {windowEndsAt}.',
    },
    ar: {
      title: 'سيحضر المحصّل',
      body: 'سيحضر المحصّل بين {windowStartsAt} و{windowEndsAt}.',
    },
  },
  'collector_visit.failed': {
    en: {
      title: 'The collector could not collect',
      body: 'The collection visit did not take place ({reason}). See the app for another time.',
    },
    ar: {
      title: 'تعذّر التحصيل',
      body: 'لم تتم زيارة التحصيل ({reason}). اطّلع على التطبيق لموعد آخر.',
    },
  },
  'finance.spending_report_published': {
    en: {
      title: 'Where the fees went',
      body: 'The {fiscalYear} spending report up to {asOf} is in the app.',
    },
    ar: {
      title: 'أين ذهبت الرسوم',
      body: 'تقرير إنفاق {fiscalYear} حتى {asOf} متاح في التطبيق.',
    },
  },
  'instalment_plan.created': {
    en: {
      title: 'Instalment plan set up',
      body: 'An invoice for your unit was split into instalments. Open the app for the schedule.',
    },
    ar: {
      title: 'تم إنشاء خطة تقسيط',
      body: 'تم تقسيط فاتورة لوحدتك. افتح التطبيق لمعرفة مواعيد الأقساط.',
    },
  },
  'invoice.dispute_accepted': {
    en: {
      title: 'Dispute accepted',
      body: 'Your dispute of an invoice was accepted. Open the app for the new amount.',
    },
    ar: {
      title: 'تم قبول الاعتراض',
      body: 'تم قبول اعتراضك على فاتورة. افتح التطبيق لمعرفة المبلغ الجديد.',
    },
  },
  'formal_notice.issued': {
    en: {
      title: 'A formal notice',
      body: 'The management sent you a formal notice. Open it to read it.',
    },
    ar: {
      title: 'إنذار رسمي',
      body: 'أرسلت إليك الإدارة إنذارًا رسميًا. افتحه لقراءته.',
    },
  },
  'credit_note.issued': {
    en: {
      title: 'Invoice credited',
      body: 'The management credited one of your invoices. Open it to see the amount.',
    },
    ar: {
      title: 'خصم على فاتورة',
      body: 'خصمت الإدارة مبلغًا من إحدى فواتيرك. افتحها لمعرفة القيمة.',
    },
  },
  'compensation.granted': {
    en: {
      title: 'Compensation granted',
      body: 'The management granted you a compensation as a credit on an invoice.',
    },
    ar: {
      title: 'تعويض',
      body: 'منحتك الإدارة تعويضًا في صورة خصم على فاتورة.',
    },
  },
  'payment.failed': {
    en: {
      title: 'Payment failed',
      body: 'Your online payment did not go through. Try again or choose another way to pay.',
    },
    ar: {
      title: 'لم يتم الدفع',
      body: 'لم ينجح الدفع الإلكتروني. حاول مرة أخرى أو اختر طريقة دفع أخرى.',
    },
  },
  'invoice.dispute_rejected': {
    en: {
      title: 'Dispute not accepted',
      body: 'Your dispute of an invoice was not accepted. Open the app for the reason.',
    },
    ar: {
      title: 'لم يتم قبول الاعتراض',
      body: 'لم يتم قبول اعتراضك على فاتورة. افتح التطبيق لمعرفة السبب.',
    },
  },
  'guard_shift.absent': {
    en: {
      title: 'Guard absent',
      body: 'A guard did not start their shift. Open the roster.',
    },
    ar: {
      title: 'غياب فرد أمن',
      body: 'لم يبدأ أحد أفراد الأمن ورديته. افتح جدول الورديات.',
    },
  },
  'guard_shift.absent_unmanned': {
    en: {
      title: 'Post unmanned',
      body: 'A guard did not start their shift and nobody is on duty there.',
    },
    ar: {
      title: 'موقع بلا حراسة',
      body: 'لم يبدأ أحد أفراد الأمن ورديته ولا يوجد أحد في الخدمة هناك.',
    },
  },
  'guard_task.assigned': {
    en: {
      title: 'New task',
      body: 'You have a new task. Open your work list.',
    },
    ar: {
      title: 'مهمة جديدة',
      body: 'لديك مهمة جديدة. افتح قائمة أعمالك.',
    },
  },
  'guard_task.unit_inspected': {
    en: {
      title: 'Your unit was inspected',
      body: 'Security inspected your closed unit. The result is in the app.',
    },
    ar: {
      title: 'تم تفقد وحدتك',
      body: 'تفقد الأمن وحدتك المغلقة. النتيجة في التطبيق.',
    },
  },
  'unit_inspection.requested': {
    en: {
      title: 'An inspection is asked for',
      body: 'The owner of a closed unit asks for a visit around {preferredOn}. Schedule it from the requests.',
    },
    ar: {
      title: 'طلب تفقد وحدة',
      body: 'يطلب مالك وحدة مغلقة زيارة تفقد في حدود {preferredOn}. جدولها من الطلبات.',
    },
  },
  'guard_swap.requested': {
    en: {
      title: 'Swap request',
      body: 'A colleague asks you to take one of their shifts.',
    },
    ar: {
      title: 'طلب تبديل',
      body: 'يطلب منك زميل أن تأخذ إحدى وردياته.',
    },
  },
  'guard_swap.accepted': {
    en: {
      title: 'Swap to decide',
      body: 'A shift swap awaits your approval.',
    },
    ar: {
      title: 'تبديل بانتظار القرار',
      body: 'تبديل ورديات بانتظار موافقتك.',
    },
  },
  'guard_swap.declined': {
    en: {
      title: 'Swap declined',
      body: 'Your colleague declined the shift swap.',
    },
    ar: {
      title: 'رُفض التبديل',
      body: 'رفض زميلك تبديل الوردية.',
    },
  },
  'guard_swap.approved': {
    en: {
      title: 'Swap approved',
      body: 'The shift swap was approved. Check your schedule.',
    },
    ar: {
      title: 'تمت الموافقة على التبديل',
      body: 'تمت الموافقة على تبديل الوردية. راجع جدولك.',
    },
  },
  'guard_swap.rejected': {
    en: {
      title: 'Swap rejected',
      body: 'The shift swap was not approved.',
    },
    ar: {
      title: 'لم تتم الموافقة على التبديل',
      body: 'لم تتم الموافقة على تبديل الوردية.',
    },
  },
  'guard_swap.expired': {
    en: {
      title: 'Swap expired',
      body: 'The shift started before the swap was decided.',
    },
    ar: {
      title: 'انتهت مهلة التبديل',
      body: 'بدأت الوردية قبل البت في التبديل.',
    },
  },
  'guard_swap.cancelled': {
    en: {
      title: 'Swap cancelled',
      body: 'The shift swap no longer applies.',
    },
    ar: {
      title: 'أُلغي التبديل',
      body: 'لم يعد تبديل الوردية ساريًا.',
    },
  },
  'guard_instruction.issued': {
    en: {
      title: 'New instruction',
      body: 'You have a new instruction to read and acknowledge.',
    },
    ar: {
      title: 'تعليمات جديدة',
      body: 'لديك تعليمات جديدة للقراءة والإقرار.',
    },
  },
  'guard_instruction.urgent': {
    en: {
      title: 'Urgent instruction',
      body: 'Read and acknowledge an urgent instruction now.',
    },
    ar: {
      title: 'تعليمات عاجلة',
      body: 'اقرأ تعليمات عاجلة وأقر بها الآن.',
    },
  },
  'governance_board.seat': {
    en: {
      title: 'You are on the board',
      body: 'You took a seat on the owners’ board. Open the app to see the board.',
    },
    ar: {
      title: 'أصبحت عضوًا في المجلس',
      body: 'أصبحت عضوًا في مجلس الملاك. افتح التطبيق لعرض المجلس.',
    },
  },
  'governance_poll.opened': {
    en: {
      title: 'A vote is open',
      body: 'The owners’ board opened a vote. Open the app to cast your unit’s vote.',
    },
    ar: {
      title: 'تصويت مفتوح',
      body: 'فتح مجلس الملاك تصويتًا. افتح التطبيق للإدلاء بصوت وحدتك.',
    },
  },
  'governance_poll.closing_soon': {
    en: {
      title: 'A vote closes soon',
      body: 'A vote closes within a day and your unit has not voted. Open the app to vote.',
    },
    ar: {
      title: 'تصويت يُغلق قريبًا',
      body: 'يُغلق تصويت خلال يوم ولم تصوّت وحدتك بعد. افتح التطبيق للتصويت.',
    },
  },
  'governance_poll.result': {
    en: {
      title: 'A vote has a result',
      body: 'A vote of the owners closed. Open the app to see the result.',
    },
    ar: {
      title: 'نتيجة تصويت',
      body: 'أُغلق تصويت للملاك. افتح التطبيق لمعرفة النتيجة.',
    },
  },
  'governance_election.nominations_opened': {
    en: {
      title: 'Stand for the board',
      body: 'Nominations for the owners’ board are open. Open the app to stand.',
    },
    ar: {
      title: 'الترشح للمجلس',
      body: 'باب الترشح لمجلس الملاك مفتوح. افتح التطبيق للترشح.',
    },
  },
  'governance_election.opened': {
    en: {
      title: 'Elect the board',
      body: 'Voting for the owners’ board is open. Open the app to cast your unit’s vote.',
    },
    ar: {
      title: 'انتخاب المجلس',
      body: 'التصويت لمجلس الملاك مفتوح. افتح التطبيق للإدلاء بصوت وحدتك.',
    },
  },
  'governance_election.closing_soon': {
    en: {
      title: 'The board election closes soon',
      body: 'Voting for the board closes within a day and your unit has not voted. Open the app to vote.',
    },
    ar: {
      title: 'انتخاب المجلس يُغلق قريبًا',
      body: 'يُغلق التصويت للمجلس خلال يوم ولم تصوّت وحدتك بعد. افتح التطبيق للتصويت.',
    },
  },
  'governance_election.awaiting_certification': {
    en: {
      title: 'Election to certify',
      body: 'Voting for the board closed. Open the dashboard to certify the result.',
    },
    ar: {
      title: 'انتخاب بانتظار الاعتماد',
      body: 'أُغلق التصويت للمجلس. افتح لوحة التحكم لاعتماد النتيجة.',
    },
  },
  'governance_election.cancelled': {
    en: {
      title: 'Election cancelled',
      body: 'An election of the board was cancelled. Open the app to see why.',
    },
    ar: {
      title: 'تم إلغاء انتخاب',
      body: 'تم إلغاء انتخاب للمجلس. افتح التطبيق لمعرفة السبب.',
    },
  },
  'governance_election.result': {
    en: {
      title: 'The board is elected',
      body: 'The board election’s result was certified. Open the app to see the new board.',
    },
    ar: {
      title: 'تم انتخاب المجلس',
      body: 'تم اعتماد نتيجة انتخاب المجلس. افتح التطبيق لعرض المجلس الجديد.',
    },
  },
  'governance_approval.raised': {
    en: {
      title: 'A decision awaits the board',
      body: 'The management put a decision to the board. Open the dashboard to read it.',
    },
    ar: {
      title: 'قرار بانتظار المجلس',
      body: 'عرضت الإدارة قرارًا على المجلس. افتح لوحة التحكم لقراءته.',
    },
  },
  'governance_approval.decided': {
    en: {
      title: 'The board decided',
      body: 'The board decided a request put to it. Open the dashboard to see the decision.',
    },
    ar: {
      title: 'قرر المجلس',
      body: 'قرر المجلس في طلب عُرض عليه. افتح لوحة التحكم لعرض القرار.',
    },
  },
  'governance_approval.overdue': {
    en: {
      title: 'A decision is overdue',
      body: 'A request to the board passed its deadline undecided. Open the dashboard.',
    },
    ar: {
      title: 'قرار متأخر',
      body: 'تجاوز طلب إلى المجلس موعده دون قرار. افتح لوحة التحكم.',
    },
  },
  'governance_approval.implemented': {
    en: {
      title: 'A decision was implemented',
      body: 'The management implemented a decision of the board. Open the dashboard.',
    },
    ar: {
      title: 'تم تنفيذ قرار',
      body: 'نفذت الإدارة قرارًا للمجلس. افتح لوحة التحكم.',
    },
  },
  'governance_approval.withdrawn': {
    en: {
      title: 'A request was withdrawn',
      body: 'The management withdrew a request it put to the board.',
    },
    ar: {
      title: 'تم سحب طلب',
      body: 'سحبت الإدارة طلبًا عرضته على المجلس.',
    },
  },
  'governance_motion.proposed': {
    en: {
      title: 'A motion to vote on',
      body: 'A board member proposed a motion. Open the dashboard to vote.',
    },
    ar: {
      title: 'اقتراح للتصويت',
      body: 'اقترح عضو في المجلس قرارًا. افتح لوحة التحكم للتصويت.',
    },
  },
  'governance_appeal.lodged': {
    en: {
      title: 'An appeal to the board',
      body: 'An owner appealed a decision of the management to the board. Open the dashboard.',
    },
    ar: {
      title: 'تظلم إلى المجلس',
      body: 'تظلم أحد الملاك إلى المجلس من قرار للإدارة. افتح لوحة التحكم.',
    },
  },
  'governance_appeal.decided': {
    en: {
      title: 'The board decided an appeal',
      body: 'The board decided an appeal. Open the app to see the decision.',
    },
    ar: {
      title: 'قرر المجلس في تظلم',
      body: 'قرر المجلس في تظلم. افتح التطبيق لعرض القرار.',
    },
  },
  'governance_appeal.overdue': {
    en: {
      title: 'An appeal is overdue',
      body: 'An appeal to the board passed its deadline undecided. Open the dashboard.',
    },
    ar: {
      title: 'تظلم متأخر',
      body: 'تجاوز تظلم إلى المجلس موعده دون قرار. افتح لوحة التحكم.',
    },
  },
  'patrol.late': {
    en: {
      title: 'Patrol late',
      body: 'A patrol at your post has not started. Open your patrols.',
    },
    ar: {
      title: 'جولة متأخرة',
      body: 'لم تبدأ جولة في موقعك بعد. افتح جولاتك.',
    },
  },
  'patrol.missed': {
    en: {
      title: 'Patrol missed',
      body: 'A scheduled patrol was not started. Open the patrol runs.',
    },
    ar: {
      title: 'جولة فائتة',
      body: 'لم تبدأ جولة مجدولة. افتح جولات الحراسة.',
    },
  },
  'patrol.incomplete': {
    en: {
      title: 'Patrol incomplete',
      body: 'A patrol ended with checkpoints not scanned. Open the patrol runs.',
    },
    ar: {
      title: 'جولة غير مكتملة',
      body: 'انتهت جولة دون مسح كل نقاط التفتيش. افتح جولات الحراسة.',
    },
  },
  'gate_lockdown.started': {
    en: {
      title: 'Lockdown',
      body: 'The gates are locked down. Let nobody in but residents.',
    },
    ar: {
      title: 'إغلاق أمني',
      body: 'البوابات مغلقة. لا تُدخل أحدًا غير السكان.',
    },
  },
  'gate_lockdown.resident_notice': {
    en: {
      title: 'Security notice',
      body: 'Security has closed the compound’s gates to visitors for now.',
    },
    ar: {
      title: 'تنبيه أمني',
      body: 'أغلق الأمن بوابات الكمبوند أمام الزوار مؤقتًا.',
    },
  },
  'gate_lockdown.ended': {
    en: {
      title: 'Lockdown ended',
      body: 'The gates are open again as usual.',
    },
    ar: {
      title: 'انتهى الإغلاق',
      body: 'عادت البوابات إلى العمل كالمعتاد.',
    },
  },
  'blocklist.ban_matched': {
    en: {
      title: 'Blocklist match',
      body: 'Someone on the blocklist was met at the gate. Open the blocklist.',
    },
    ar: {
      title: 'تطابق في قائمة الحظر',
      body: 'وُجد شخص من قائمة الحظر عند البوابة. افتح قائمة الحظر.',
    },
  },
  'blocklist.watch_matched': {
    en: {
      title: 'Watchlist match',
      body: 'Someone on the watchlist was met at the gate. Open the blocklist.',
    },
    ar: {
      title: 'تطابق في قائمة المراقبة',
      body: 'وُجد شخص من قائمة المراقبة عند البوابة. افتح قائمة الحظر.',
    },
  },
  'visitor_pass.refused_by_security': {
    en: {
      title: 'Visitor refused',
      body: 'Security did not let your visitor in.',
    },
    ar: {
      title: 'لم يُسمح للزائر',
      body: 'لم يسمح الأمن بدخول زائرك.',
    },
  },
  'unit_permit.refused_by_security': {
    en: {
      title: 'Refused at the gate',
      body: 'Security did not let someone of your permit in.',
    },
    ar: {
      title: 'رُفض عند البوابة',
      body: 'لم يسمح الأمن بدخول أحد من تصريحك.',
    },
  },
  'unit_permit.work_stopped': {
    en: {
      title: 'Work stopped',
      body: 'Security stopped the work under your permit. Open the permit.',
    },
    ar: {
      title: 'تم إيقاف العمل',
      body: 'أوقف الأمن العمل المسموح به في تصريحك. افتح التصريح.',
    },
  },
  'unit_permit.work_resumed': {
    en: {
      title: 'Work may go on',
      body: 'The management let the work under your permit go on.',
    },
    ar: {
      title: 'يمكن استئناف العمل',
      body: 'سمحت الإدارة باستئناف العمل في تصريحك.',
    },
  },
  'incident.reported': {
    en: {
      title: 'Incident reported',
      body: 'A new incident was reported. Open the incidents.',
    },
    ar: {
      title: 'بلاغ عن حادث',
      body: 'تم الإبلاغ عن حادث جديد. افتح الحوادث.',
    },
  },
  'incident.critical': {
    en: {
      title: 'Critical incident',
      body: 'A critical incident was reported. Open it now.',
    },
    ar: {
      title: 'حادث خطير',
      body: 'تم الإبلاغ عن حادث خطير. افتحه الآن.',
    },
  },
  'incident.assigned': {
    en: {
      title: 'Incident to investigate',
      body: 'An incident was assigned to you. Open it.',
    },
    ar: {
      title: 'حادث للتحقيق',
      body: 'أُسند إليك التحقيق في حادث. افتحه.',
    },
  },
  'violation.issued': {
    en: {
      title: 'A violation',
      body: 'Your unit was given a violation notice. Open it to see why.',
    },
    ar: {
      title: 'مخالفة',
      body: 'صدر إخطار مخالفة لوحدتك. افتحه لمعرفة السبب.',
    },
  },
  'violation.appeal_upheld': {
    en: {
      title: 'Appeal decided',
      body: 'Your appeal of the violation was not accepted.',
    },
    ar: {
      title: 'تم البت في الطعن',
      body: 'لم يُقبل طعنك على المخالفة.',
    },
  },
  'violation.appeal_accepted': {
    en: {
      title: 'Appeal accepted',
      body: 'Your appeal was accepted: the violation is cancelled.',
    },
    ar: {
      title: 'قُبل الطعن',
      body: 'قُبل طعنك وأُلغيت المخالفة.',
    },
  },
  'child.unauthorized_pickup': {
    en: {
      title: 'Child pickup refused',
      body: 'Someone not allowed tried to collect a child of your home at the gate. Open the app.',
    },
    ar: {
      title: 'رُفض استلام طفل',
      body: 'حاول شخص غير مصرح له استلام طفل من منزلكم عند البوابة. افتح التطبيق.',
    },
  },
  'child.exit_alone': {
    en: {
      title: 'Child held at the gate',
      body: 'A child of your home tried to leave alone and was held at the gate. Open the app.',
    },
    ar: {
      title: 'طفل عند البوابة',
      body: 'حاول طفل من منزلكم الخروج وحده واستوقفه الأمن عند البوابة. افتح التطبيق.',
    },
  },
  'child.picked_up': {
    en: {
      title: 'Child left the compound',
      body: 'A child of your home has left the compound. Open the app for details.',
    },
    ar: {
      title: 'خروج طفل',
      body: 'خرج طفل من منزلكم من الكمبوند. افتح التطبيق للتفاصيل.',
    },
  },
  // Field exceptions (ADR 0056): no name, no plate.
  'gate_exception.requested': {
    en: {
      title: 'An exception to decide',
      body: 'A guard at {gateName} asks to let someone in for unit {unitCode}. Open the app to answer.',
    },
    ar: {
      title: 'استثناء بانتظار قرارك',
      body: 'يطلب أحد الحراس عند {gateName} السماح بدخول شخص للوحدة {unitCode}. افتح التطبيق للرد.',
    },
  },
  'gate_exception.decided': {
    en: {
      title: 'The management answered',
      body: 'Your exception for unit {unitCode} was answered. Open the app to see it.',
    },
    ar: {
      title: 'ردّت الإدارة',
      body: 'تم الرد على طلب الاستثناء الخاص بالوحدة {unitCode}. افتح التطبيق للاطلاع.',
    },
  },
  'gate_exception.expired': {
    en: {
      title: 'No answer in time',
      body: 'Nobody answered your exception for unit {unitCode}. Do not let them in.',
    },
    ar: {
      title: 'لم يصل رد في الوقت المحدد',
      body: 'لم يرد أحد على طلب الاستثناء الخاص بالوحدة {unitCode}. لا تسمح بالدخول.',
    },
  },
  'visit.overstayed': {
    en: {
      title: 'A visitor is still inside',
      body: 'A visitor for unit {unitCode} is still inside after {minutes} minutes.',
    },
    ar: {
      title: 'زائر ما زال بالداخل',
      body: 'زائر الوحدة {unitCode} ما زال بالداخل بعد {minutes} دقيقة.',
    },
  },
  'visit.overstayed_host': {
    en: {
      title: 'Your visitor is still inside',
      body: 'Your visitor is still in the compound after {minutes} minutes.',
    },
    ar: {
      title: 'زائرك ما زال بالداخل',
      body: 'زائرك ما زال داخل المجمع بعد {minutes} دقيقة.',
    },
  },
  'patrol.geofence_exit': {
    en: {
      title: 'Patrol left its area',
      body: 'A guard on patrol has been outside the route’s area for {minutes} minutes or more. Open the run.',
    },
    ar: {
      title: 'خروج الجولة عن نطاقها',
      body: 'خرج أحد الحراس في جولة عن نطاق المسار لمدة {minutes} دقيقة أو أكثر. افتح الجولة.',
    },
  },
  'gate_offline.security_conflict': {
    en: {
      title: 'Offline gate: security conflict',
      body: 'A gate device synced {flags} security conflict(s) from offline. Open the offline flags.',
    },
    ar: {
      title: 'البوابة دون اتصال: تعارض أمني',
      body: 'زامن جهاز بوابة {flags} تعارضاً أمنياً سُجّل دون اتصال. افتح تنبيهات العمل دون اتصال.',
    },
  },
  'gate_offline.conflicts': {
    en: {
      title: 'Offline gate: entries to review',
      body: 'A gate device synced {flags} entry conflict(s) from offline. Open the offline flags.',
    },
    ar: {
      title: 'البوابة دون اتصال: دخول للمراجعة',
      body: 'زامن جهاز بوابة {flags} تعارضاً في الدخول سُجّل دون اتصال. افتح تنبيهات العمل دون اتصال.',
    },
  },
  'gate_offline.lockdown_entered': {
    en: {
      title: 'Entry during a lockdown',
      body: 'A device synced an entry recorded offline while this gate was locked down. Tell your supervisor.',
    },
    ar: {
      title: 'دخول أثناء الإغلاق',
      body: 'زامن جهاز دخولاً سُجّل دون اتصال أثناء إغلاق هذه البوابة. أبلغ مشرفك.',
    },
  },
  'gate_device.upload_rejected': {
    en: {
      title: 'Gate device upload refused',
      body: 'A gate device’s offline upload was refused. Check the device; revoke it if it is not yours.',
    },
    ar: {
      title: 'رُفض رفع من جهاز بوابة',
      body: 'رُفض رفع بيانات العمل دون اتصال من جهاز بوابة. افحص الجهاز وألغِه إن لم يكن تابعاً لكم.',
    },
  },
  'gate_device.sync_overdue': {
    en: {
      title: 'Gate device not syncing',
      body: 'A gate device on shift has not been seen for {minutes} minutes. Check the gate’s network.',
    },
    ar: {
      title: 'جهاز بوابة لا يزامن',
      body: 'لم يظهر جهاز بوابة في وردية منذ {minutes} دقيقة. تحقّق من شبكة البوابة.',
    },
  },
  'gate_device.sequence_gap': {
    en: {
      title: 'Gate device: actions missing',
      body: '{missing} action(s) recorded offline on a gate device never arrived. Check the device.',
    },
    ar: {
      title: 'جهاز بوابة: إجراءات ناقصة',
      body: 'لم يصل {missing} إجراء سُجّل دون اتصال على جهاز بوابة. افحص الجهاز.',
    },
  },
  'gate_device.enrolled': {
    en: {
      title: 'New gate device',
      body: 'A guard enrolled a device for the gate offline. Revoke it if you do not recognise it.',
    },
    ar: {
      title: 'جهاز بوابة جديد',
      body: 'سجّل أحد الحراس جهازاً للعمل على البوابة دون اتصال. ألغِه إن لم تتعرف عليه.',
    },
  },
  'partner_request.accepted': {
    en: {
      title: 'Request accepted',
      body: 'The partner accepted your service request.',
    },
    ar: {
      title: 'تم قبول الطلب',
      body: 'قبل مقدم الخدمة طلبك.',
    },
  },
  'partner_request.declined': {
    en: {
      title: 'Request declined',
      body: 'The partner could not take your service request.',
    },
    ar: {
      title: 'تم رفض الطلب',
      body: 'لم يتمكن مقدم الخدمة من قبول طلبك.',
    },
  },
  'partner_request.proposed': {
    en: {
      title: 'Another time proposed',
      body: 'The partner proposed another time for your request. Accept or decline it.',
    },
    ar: {
      title: 'موعد آخر مقترح',
      body: 'اقترح مقدم الخدمة موعداً آخر لطلبك. اقبله أو ارفضه.',
    },
  },
  'partner_request.cancelled': {
    en: {
      title: 'Request cancelled',
      body: 'Your service request was cancelled.',
    },
    ar: {
      title: 'تم إلغاء الطلب',
      body: 'أُلغي طلب الخدمة الخاص بك.',
    },
  },
  'partner_request.done': {
    en: {
      title: 'Service done',
      body: 'The partner marked your request done. How did it go?',
    },
    ar: {
      title: 'تمت الخدمة',
      body: 'أشار مقدم الخدمة إلى إتمام طلبك. كيف كانت الخدمة؟',
    },
  },
  'partner_request.expired': {
    en: {
      title: 'Request expired',
      body: 'Nobody accepted your service request in time.',
    },
    ar: {
      title: 'انتهت صلاحية الطلب',
      body: 'لم يُقبل طلب الخدمة الخاص بك في الوقت المناسب.',
    },
  },
  'partner_request.awaiting_relay': {
    en: {
      title: 'A request to relay',
      body: 'A resident asked a partner without a desk link. Relay the request.',
    },
    ar: {
      title: 'طلب للتحويل',
      body: 'طلب أحد السكان خدمة من مقدم خدمة بلا رابط مكتب. حوّل الطلب إليه.',
    },
  },
  'partner_complaint.decided': {
    en: {
      title: 'Your complaint was decided',
      body: 'The management decided your complaint about a service partner.',
    },
    ar: {
      title: 'تم البت في شكواك',
      body: 'بتّت الإدارة في شكواك من مقدم خدمة.',
    },
  },
  'partner.suspended': {
    en: {
      title: 'A service partner is unavailable',
      body: 'A partner you asked or follow was suspended. See the alternatives.',
    },
    ar: {
      title: 'مقدم خدمة غير متاح',
      body: 'أُوقف مقدم خدمة طلبت منه أو تتابعه. اطّلع على البدائل.',
    },
  },
  'decision_appeal.lodged': {
    en: {
      title: 'A decision was appealed',
      body: 'A resident appealed a staff decision. Review the appeal.',
    },
    ar: {
      title: 'تظلم من قرار',
      body: 'تظلم أحد السكان من قرار للإدارة. راجع التظلم.',
    },
  },
  'decision_appeal.decided': {
    en: {
      title: 'Your appeal was decided',
      body: 'The management decided an appeal about your unit. Open the app to see why.',
    },
    ar: {
      title: 'صدر قرار في التظلم',
      body: 'قررت الإدارة في تظلم يخص وحدتك. افتح التطبيق لمعرفة الأسباب.',
    },
  },
  'worker.engagement_rejected': {
    en: {
      title: 'A worker was not approved',
      body: 'The management did not approve a worker you registered. You may appeal within 15 days.',
    },
    ar: {
      title: 'لم تتم الموافقة على عامل',
      body: 'لم توافق الإدارة على عامل سجلته. يمكنك التظلم خلال 15 يومًا.',
    },
  },
  'governance_representative.appointed': {
    en: {
      title: 'You represent your building',
      body: 'The board named you the representative of building {building}.',
    },
    ar: {
      title: 'أنت ممثل المبنى',
      body: 'عيّنك المجلس ممثلًا للمبنى {building}.',
    },
  },
  'governance_representative.ended': {
    en: {
      title: 'Your representation ended',
      body: 'Your term as the representative of building {building} has ended.',
    },
    ar: {
      title: 'انتهت فترة تمثيلك',
      body: 'انتهت فترتك ممثلًا للمبنى {building}.',
    },
  },
  'representative.message_received': {
    en: {
      title: 'A message from your building',
      body: 'A resident of your building wrote to you. Open the app to read it.',
    },
    ar: {
      title: 'رسالة من مبناك',
      body: 'كتب إليك أحد سكان مبناك. افتح التطبيق لقراءتها.',
    },
  },
  'representative.replied': {
    en: {
      title: 'Your representative answered',
      body: 'Your building’s representative answered you. Open the app to read it.',
    },
    ar: {
      title: 'ردّ ممثل المبنى',
      body: 'ردّ عليك ممثل مبناك. افتح التطبيق لقراءة الرد.',
    },
  },
  'governance_agenda.proposed': {
    en: {
      title: 'An agenda proposal',
      body: 'An owner proposed a matter for the board. Review the proposal.',
    },
    ar: {
      title: 'مقترح لجدول الأعمال',
      body: 'اقترح أحد الملاك موضوعًا على المجلس. راجع المقترح.',
    },
  },
  'governance_agenda.decided': {
    en: {
      title: 'Your proposal was decided',
      body: 'The board decided on your agenda proposal. Open the app to see it.',
    },
    ar: {
      title: 'صدر قرار في مقترحك',
      body: 'قرر المجلس في مقترحك لجدول الأعمال. افتح التطبيق للاطلاع.',
    },
  },
  'governance_objection.lodged': {
    en: {
      title: 'An objection to a decision',
      body: 'An owner objected to a decision the board published.',
    },
    ar: {
      title: 'اعتراض على قرار',
      body: 'اعترض أحد الملاك على قرار نشره المجلس.',
    },
  },
  'governance_objection.answered': {
    en: {
      title: 'The board answered your objection',
      body: 'The board answered the objections to its decision. Open the app to read it.',
    },
    ar: {
      title: 'ردّ المجلس على اعتراضك',
      body: 'ردّ المجلس على الاعتراضات على قراره. افتح التطبيق لقراءة الرد.',
    },
  },
  'asset.warranty_expiring': {
    en: {
      title: 'Warranty ending',
      body: 'The warranty of asset {assetRef} ends on {endsOn}.',
    },
    ar: {
      title: 'ضمان على وشك الانتهاء',
      body: 'ينتهي ضمان الأصل {assetRef} يوم {endsOn}.',
    },
  },
  'maintenance.plan_overdue': {
    en: {
      title: 'Planned work overdue',
      body: 'The planned work on asset {assetRef}, due {dueOn}, is overdue.',
    },
    ar: {
      title: 'صيانة مخططة متأخرة',
      body: 'تأخرت الصيانة المخططة للأصل {assetRef} المستحقة يوم {dueOn}.',
    },
  },
  'inspection.assigned': {
    en: {
      title: 'Inspection to do',
      body: 'An inspection of {targetRef} is yours, due {dueOn}.',
    },
    ar: {
      title: 'تفتيش مطلوب',
      body: 'لديك تفتيش على {targetRef} مستحق يوم {dueOn}.',
    },
  },
  'work_permit.requested': {
    en: {
      title: 'Work permit to decide',
      body: 'Ticket {ticketNumber} asks for a {hazard} permit.',
    },
    ar: {
      title: 'تصريح عمل بانتظار القرار',
      body: 'البلاغ {ticketNumber} يطلب تصريح عمل ({hazard}).',
    },
  },
  'work_permit.approved': {
    en: {
      title: 'Work permit approved',
      body: 'Your {hazard} permit for ticket {ticketNumber} is approved.',
    },
    ar: {
      title: 'تمت الموافقة على التصريح',
      body: 'تمت الموافقة على تصريح ({hazard}) للبلاغ {ticketNumber}.',
    },
  },
  'work_permit.rejected': {
    en: {
      title: 'Work permit rejected',
      body: 'Your {hazard} permit for ticket {ticketNumber} was rejected.',
    },
    ar: {
      title: 'رُفض التصريح',
      body: 'رُفض تصريح ({hazard}) للبلاغ {ticketNumber}.',
    },
  },
  'work_permit.revoked': {
    en: {
      title: 'Work permit revoked',
      body: 'Your {hazard} permit for ticket {ticketNumber} was revoked: stop that work safely.',
    },
    ar: {
      title: 'أُلغي التصريح',
      body: 'أُلغي تصريح ({hazard}) للبلاغ {ticketNumber}: أوقف هذا العمل بأمان.',
    },
  },
  'readiness_item.assigned': {
    en: {
      title: 'Readiness item',
      body: 'An item of a readiness program is yours, due {dueOn}.',
    },
    ar: {
      title: 'مهمة استعداد',
      body: 'أُسندت إليك مهمة في برنامج استعداد، مستحقة يوم {dueOn}.',
    },
  },
  'readiness_item.overdue': {
    en: {
      title: 'Readiness item overdue',
      body: 'Your readiness item, due {dueOn}, is overdue.',
    },
    ar: {
      title: 'مهمة استعداد متأخرة',
      body: 'تأخرت مهمة الاستعداد المسندة إليك والمستحقة يوم {dueOn}.',
    },
  },
  'inspection.overdue': {
    en: {
      title: 'Inspection overdue',
      body: 'The inspection of {targetRef}, due {dueOn}, is overdue.',
    },
    ar: {
      title: 'تفتيش متأخر',
      body: 'تأخر التفتيش على {targetRef} المستحق يوم {dueOn}.',
    },
  },
  'asset.replacement_recommended': {
    en: {
      title: 'Replacement recommended',
      body: 'A technician recommends replacing asset {assetRef}.',
    },
    ar: {
      title: 'توصية باستبدال أصل',
      body: 'يوصي فني باستبدال الأصل {assetRef}.',
    },
  },
  'control_room.alert': {
    en: {
      title: 'Control room alert',
      body: 'A guard or a gate needs you now. Open the control room.',
    },
    ar: {
      title: 'تنبيه غرفة التحكم',
      body: 'حارس أو بوابة يحتاجك الآن. افتح غرفة التحكم.',
    },
  },
  'control_room.event': {
    en: {
      title: 'Control room',
      body: 'Something happened at the gates. Open the control room.',
    },
    ar: {
      title: 'غرفة التحكم',
      body: 'حدث شيء عند البوابات. افتح غرفة التحكم.',
    },
  },
};

/** The names between braces in a text. */
export function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]);
}

/**
 * The title and body of a push. A param the stored notification no longer
 * has renders as nothing rather than as its name.
 */
export function renderPush(
  kind: NotificationKind,
  locale: Locale,
  params: NotificationParams,
): PushText {
  const text = PUSH_TEXTS[kind][locale];
  const fill = (s: string) =>
    s.replace(/\{([A-Za-z]+)\}/g, (_, name: string) =>
      name in params ? String(params[name]) : '',
    );
  return { title: fill(text.title), body: fill(text.body) };
}
