# الزائر: إشعارات الدخول، إعادة الدعوة، والطريق — Visitor notices, re-invite and route

> **التطبيق/الواجهة:** تطبيق الساكن؛ صفحة الزائر من غير دخول؛ لوحة المدير `/gate`
> **الصلاحيات:** `visitors.invite`؛ الإشعارات: `visitorsNotify`؛ البوابات: `gate.manage`
> **المصادر:** ADR 0071 (بتقفل النقط المفتوحة في ADR 0043) · `src/gate/visitors` · `src/gate/gates` · `src/gate/approvals`

## إشعار الدخول والخروج
- الكارنيه فيه `notifyOnEntry`: شغال افتراضي، ومقفول افتراضي على الكارنيه المتكرر (والقديم المتكرر اتقفل). بيظهر في تفاصيل الكارنيه.
- المضيف وأصحاب `visitorsNotify` في الوحدة بيتبلغوا `visitor_pass.entered` / `.exited {gateName}` — الكارنيه والبوابة بس، **مش اسم الزائر**. أونلاين ومن جهاز الحارس الأوفلاين.

## التعليمات الدايمة
- `notify` على تعليمة `always_allow`: لما الحارس يدخّل حد بيها، البيت بيتبلغ `gate.let_in_by_instruction` مرة واحدة — الطلب بس، لا اسم الزائر ولا كلام التعليمة.

## إعادة الدعوة
- `POST /visitor-passes/:id/reinvite { validFrom, validUntil, schedule? }` على كارنيه إنت كنت مضيفه: كارنيه جديد بنفس الزائر ونفس النوع والعدد، وبيعدّي على كل فحوصات الكارنيه الجديد.
- بعد ما الكومباوند يمسح بيانات الزائر: `409 VISITOR_DETAILS_PURGED` — اعرض كارنيه جديد بدلها.

## الطريق قبل الوصول
- الإدارة: كل بوابة ليها `directionsEn`/`directionsAr` (من شاشة البوابة).
- الكارنيه ممكن يحدد `expectedGateId`. صفحة الزائر بتبيّن `expectedGate { name, directionsEn, directionsAr }`، و`parkingArea` لو المضيف حاجز ركنة زائر للكارنيه ده.
