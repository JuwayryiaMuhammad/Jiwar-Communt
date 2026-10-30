# سلامة الفني — Work permits and safety instructions

> **التطبيق/الواجهة:** تطبيق الفني، وmanager dashboard (`/work-permits`، تبويب Field safety في إعداد الصيانة، لوحة التصاريح في البلاغ)
> **الصلاحيات:** `tickets.work` للفني، `safety.manage` للقرار والتعليمات (المشرف والمدير)، `maintenance.manage` لمخاطر الفئة، `assets.manage` لمخاطر نوع الأصل.
> **المصادر:** ADR 0067 · `src/maintenance/field-safety/`

## إيه اللي محتاج تصريح
- `PUT /maintenance/categories/:id/permit-hazards { hazards }` و`PUT /maintenance/asset-types/:id/permit-hazards { hazards }`: من `hot_work | height | live_electrical | confined_space | pool_chemicals`. البلاغ محتاج مخاطر فئته ومخاطر نوع أصله.

## التصريح
- الفني: `POST /technician/tickets/:id/permits { hazard, precautions, expiresAt }` (+ `Idempotency-Key`) على بلاغه اللي في إيده. `expiresAt` بالـoffset وفي خلال ٢٤ ساعة. واحد مفتوح لكل خطر في الدورة (`409 WORK_PERMIT_OPEN {permitId}`). الإجراءات كلامه: مابتطلعش في إشعار.
- القرار: `POST /maintenance/work-permits/:id/approve`، `/reject { reasonCode }` (`workPermitReject`)، `/revoke { reasonCode }` (`workPermitRevoke`، للموافق عليه بس). مرة واحدة (`409 WORK_PERMIT_DECIDED {status}`)؛ اللي انتهى وقته مايتوافقش عليه (`WORK_PERMIT_EXPIRED`).
- الإشعارات: `work_permit.requested` لأصحاب القرار؛ `approved | rejected | revoked` للفني (الخطر ورقم البلاغ بس).
- `GET /technician/tickets/:id/permits` و`GET /maintenance/tickets/:id/permits`: المخاطر المطلوبة وتصاريح الدورة.

## قاعدة البدء
- البدء (ووصول الزيارة) والرجوع بعد الإيقاف المؤقت: كل خطر مطلوب ليه تصريح موافق عليه ولسه ساري، وإلا `409 WORK_PERMIT_REQUIRED {hazards}`؛ وتعليمات الفئة الحالية متأكدة للبلاغ ده، وإلا `409 SAFETY_ACK_REQUIRED {instructionId, version}`.
- لو التصريح اتلغى والشغل ماشي: الشغل بيفضل، والفني بيتبلغ يوقفه بأمان؛ مايرجعش بعد إيقاف من غير تصريح جديد.
- الإتمام بيقفل تصاريح الدورة المفتوحة.

## تعليمات السلامة
- `POST /maintenance/categories/:id/safety-instructions { textEn, textAr }`: نسخة جديدة كل تغيير، والنسخة مابتتغيرش. `GET` نفس المسار = النسخ (الأحدث الأول).
- الفني: `GET /technician/tickets/:id/safety` (النسخة الحالية وتأكيدي) و`POST …/safety/acknowledge { instructionId }`: لازم الحالية (`409 SAFETY_INSTRUCTION_NOT_CURRENT`)، مرة واحدة، ومعاها SHA-256 للي اتعرض بالظبط (`contentSha256`).
