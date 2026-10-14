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
