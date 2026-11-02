# الفريق الميداني — جدول الفنيين، تعليماتهم، وطلب المساعدة

> **التطبيق/الواجهة:** تطبيق الفني، وmanager dashboard (`/field-team`: الجدول، الحضور، التعليمات، طلبات المساعدة)
> **الصلاحيات:** `tickets.work` للفني، `field_team.manage` لإدارة الفريق (المدير ومشرف الصيانة).
> **المصادر:** ADR 0078 · `src/gate/roster/duty-roster.*`، `src/gate/guard-instructions/technician-instructions.controller.ts`، `src/maintenance/help/`

## الجدول (نفس جدول الأمن، طاقم الصيانة)
- قالب أسبوعي أو مناوبة واحدة لفني: في منطقة أو للكمبوند كله، ومن غير بوابة أبدًا (`gateId FIELD_NOT_ALLOWED`). الفني لازم يكون نشط وعنده `tickets.work` (`GUARD_NOT_ELIGIBLE`). مافيش تداخل مع مناوباته (`409 ROSTER_OVERLAP`).
- **البدء = التوفر:** لما الفني يعمل `POST /technician/availability { state: available }` بتتملى أقرب مناوبة عنده من قبل بدايتها بنص ساعة لحد آخرها، بالتأخير (`lateMinutes`؛ أكتر من ١٠ دقايق = متأخر). لما يبقى `unavailable` بتتقفل، والدقايق بعد آخرها = `overtimeMinutes`.
- مناوبة اتعملت أو بدأت وهو متوفر: بتتملى في معادها.
- **غياب:** مش متوفر بعد ساعة من معادها → `absentAt` والفريق بيتبلغ (`technician_shift.absent`). لو اتوفر بعدها بتتملى برضه.
- الفني: `GET /maintenance/my-roster` و`/attendance`. الإدارة: `/staff/field-team/roster/*` و`/staff/field-team/attendance`. شاشات الأمن مابتشوفش مناوبات الفنيين، والعكس.
- مافيش تبديل مناوبات للفنيين.

## التعليمات
- الإدارة: `POST /staff/field-team/instructions { title, body, urgent?, validFrom?, validUntil? }` لكل الفنيين، وقائمتها وتفاصيلها (مين أكد) والأرشفة.
- الفني: `GET /maintenance/instructions?status=pending`، التفاصيل، و`POST …/{id}/acknowledge` (مرة واحدة). اللي بيتوفر وهي سارية بتوصله (`on_duty`).
- الإشعار: `technician_instruction.issued` أو `.urgent` (حرج).

## طلب المساعدة
- الفني: `POST /maintenance/help-requests { kind, ticketId?, note? }`، و`kind` من `extra_hands | expertise | parts | safety`، والبلاغ لازم يكون بتاعه. طلب واحد مفتوح بس (`409 TECHNICIAN_HELP_LIVE`).
- الفريق بيتبلغ فورًا (`technician_help.requested`، حرج، بالنوع بس من غير الكلام).
- الإدارة: `POST /staff/field-team/help-requests/{id}/take { helperId? }`: مرة واحدة، وممكن تبعت فني تاني (نشط، مش صاحب الطلب). صاحب الطلب بيتبلغ `taken`، والمساعد `assigned` (حرج).
- الإنهاء: صاحب الطلب أو المساعد (`/maintenance/help-requests/{id}/resolve`) أو الإدارة، بعد الاستلام. الإلغاء: صاحب الطلب بس وهو مفتوح أو مستلم.
- لو محدش استلمه في ١٥ دقيقة: المديرين بيتبلغوا مرة واحدة (`technician_help.escalated`، حرج)، ولسه ممكن يتستلم.
- الفني اللي بيمشي طلبه المفتوح بيتلغي، واللي بيتمسح كلامه بيتشال.
