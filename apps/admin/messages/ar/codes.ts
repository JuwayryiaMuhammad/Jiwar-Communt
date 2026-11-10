import type { Translation } from '@jiwar/i18n';
import type en from '../en/codes.ts';

const ar: Translation<typeof en> = {
  // Security events.
  'otp.requested': 'طلب رمز تحقق',
  'otp.verify_failed': 'رمز تحقق خاطئ',
  'otp.challenge_exhausted': 'نفدت محاولات رمز التحقق',
  'otp.rate_limited': 'تجاوز حد طلبات رمز التحقق',
  'login.succeeded': 'تسجيل دخول ناجح',
  'login.new_device': 'دخول من جهاز جديد',
  'session.refresh_reuse_detected': 'إعادة استخدام رمز تجديد الجلسة',
  'session.revoked': 'إنهاء جلسة',
  'platform.login_failed': 'دخول فاشل إلى المنصة',
  'platform.login_locked': 'قفل الدخول إلى المنصة',
  'platform.login_succeeded': 'دخول ناجح إلى المنصة',
  'platform.step_up_requested': 'طلب رمز تأكيد جديد للمنصة',
  'platform.step_up_verified': 'تأكيد ناجح برمز المنصة',
  'platform.step_up_failed': 'رمز تأكيد خاطئ للمنصة',
  'payment.webhook_rejected': 'رفض إشعار من بوابة الدفع',
  'payment.order_mismatch': 'طلب دفع لا يطابق عملية الدفع',
  'payment.amount_mismatch': 'مبلغ لا يطابق عملية الدفع',
  'payment.verification_contradicted': 'تعارض في تأكيد الدفع',
  'payment.duplicate_charge': 'خصم مكرر',
  'invite.token_invalid': 'رابط دعوة غير صالح',
  'account.phone_reassigned': 'نقل رقم الهاتف من الحساب',
  'registration.link_invalid': 'رابط تسجيل غير صالح',
  'step_up.requested': 'طلب رمز تأكيد جديد',
  'step_up.verified': 'تأكيد ناجح بالرمز',
  'step_up.failed': 'رمز تأكيد خاطئ',
  'account.not_me': 'بلاغ «لست أنا»',
  'guard_alarm.webhook_rejected': 'رفض إشعار من مزوّد إنذار الحراس',
  'gate_call.webhook_rejected': 'رفض إشعار من مزوّد اتصالات البوابة',
  // Platform audit actions.
  'tenant.created': 'فتح مجمع',
  'tenant.status_changed': 'تغيير حالة مجمع',
  'tenant.manager_added': 'إضافة مدير مجمع',
  'tenant.payment_gateway_set': 'تعيين بوابة الدفع لمجمع',
  'tenant.payment_gateway_toggled': 'إيقاف بوابة الدفع لمجمع أو السماح بها',
  'platform_admin.created': 'إنشاء مسؤول منصة',
  'platform_admin.password_changed': 'تغيير كلمة مرور مسؤول المنصة',
};

export default ar;
