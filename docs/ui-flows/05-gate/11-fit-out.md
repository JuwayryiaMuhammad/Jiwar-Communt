# التشطيب — تأمين الأعمال، المخططات، المخلفات، المناطق العامة قبل وبعد، والمطالبة بالأضرار

> **التطبيق/الواجهة:** تطبيق الساكن (التصريح بتاع الأعمال)، وmanager dashboard (صفحة التصريح `/permits/[id]`، وإعدادات التصاريح)، وتطبيق الحارس (المخلفات النهارده)
> **الصلاحيات:** `permits.request` للساكن (اللي طلب التصريح أو الـprimary بتاع الوحدة)، `permits.manage` للإدارة، `gate.operate` للحارس في ورديته، `deposits.manage` لتسجيل التأمين.
> **المصادر:** ADR 0074 · `src/gate/permits/fitout/` · `docs/api/notes/fit-out.md`

## التأمين قبل الموافقة
- الإدارة بتسجل تأمين التشطيب من `POST /staff/deposits { kind: "finishing_works", permitId, ... }`: تصريح أعمال للوحدة نفسها، وتأمين واحد لكل تصريح (`DUPLICATE_VALUE`).
- إعداد الكمبوند `worksDepositRequired` (شغال للكمبوندات الجديدة، ومقفول للكمبوندات اللي كانت موجودة قبله): الموافقة على تصريح أعمال من غير تأمين فيه فلوس = `409 PERMIT_DEPOSIT_REQUIRED`. الإدارة تقفله من إعدادات التصاريح.
- رد التأمين بيستنى لو فيه مطالبة أضرار مفتوحة على التصريح (`409 DEPOSIT_CLAIM_OPEN {claims}`).
- الشاشة: في صفحة التصريح كارت "Finishing-works deposit" وزرار يسجله للـprimary.

## ملف التشطيب
- `GET /permits/:id/fit-out` (الساكن) و`GET /staff/unit-permits/:id/fit-out` (الإدارة): التأمين، المخططات، المخلفات، المناطق قبل وبعد، المطالبات، و`certificateBlockedBy`.
- أي تصريح تاني أو مش بتاعك = `404 PERMIT_NOT_FOUND`. كل الردود `no-store`.

## المخططات (الساكن)
- `POST /permits/:id/drawings { fileId }` (ملف `permit_drawing`: صورة أو PDF): والتصريح مفتوح، ١٠ بالكتير (`PERMIT_DRAWING_LIMIT`).
- `POST /permits/:id/drawings/:drawingId/remove`: بيشيله مرة، والملف بيفضل في السجل.

## إخراج المخلفات
- الساكن أو الإدارة يحددوا ميعاد: يوم شغل في مدة التصريح، جوه ساعات الكمبوند، من نص ساعة لـ٤ ساعات، ولسه ماجاش، و٣ مواعيد بالكتير من غير تداخل.
- الإدارة (`…/debris-slots/:slotId/done`) أو الحارس في ورديته (`POST /gate/unit-permits/:id/debris-slots/:slotId/done`) يعلّموه اتعمل من قبله بنص ساعة.
- لو عدّى ساعتين بعد آخره من غير ما حد يعلّم، السيستم بيخليه "فات" ويبلغ صاحب الطلب والإدارة (`unit_permit.debris_missed`).
- الإلغاء قبل ما يبدأ بكود من `debrisSlotCancel`: الساكن يلغي بتاعه بس، والإدارة أي واحد.
- الحارس: `GET /gate/unit-permits/:id/debris-slots` = مواعيد النهارده.

## المناطق العامة قبل وبعد (الإدارة)
- `POST /staff/unit-permits/:id/area-records { commonAreaId, phase, photoFileIds, note? }`: `before` والتصريح مفتوح، و`after` بعد `before` (`AREA_RECORD_NO_BEFORE`)، مرة لكل منطقة ومرحلة (`AREA_RECORD_EXISTS`). من صورة لـ١٠ (`fitout_photo`)، والساكن بيشوف الصور والملاحظة.

## المطالبة بالأضرار
- الإدارة: `POST /staff/unit-permits/:id/damage-claims { reasonCode, description, amount, commonAreaId?, photoFileIds }` على تصريح موافق عليه. صاحب الطلب والـprimary بيتبلغوا (`unit_permit.damage_claimed {claimNumber}`).
- الساكن يتظلم مرة في خلال ١٤ يوم: `POST /permits/:id/damage-claims/:claimId/appeal { text, photoFileId? }`.
- الإدارة: `…/appeal-decision { decision: upheld | accepted }`، `…/withdraw { reasonCode }` (`damageClaimWithdraw`)، `…/settle` بـstep-up بعد ما التظلم يتبت فيه أو الـ١٤ يوم يعدّوا (`DAMAGE_CLAIM_APPEAL_WINDOW`).
- التسوية: من التأمين على قد اللي فيه، والباقي فاتورة `damage` على الوحدة تستحق بعد ١٤ يوم.

## شهادة الإنهاء
- النجاح في الفحص بيترفض لو فيه مخالفات أو مطالبات مفتوحة على التصريح: `409 WORKS_CERTIFICATE_BLOCKED {violations, claims}`. الشاشة بتقول قبلها من `certificateBlockedBy`.
