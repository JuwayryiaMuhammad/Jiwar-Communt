# عمق التوزيع — أوامر شغل الإدارة، والإقفال والفتح والاستكمال، وتقرير الـSLA، وسجل الأصل والضمان

> **التطبيق/الواجهة:** manager dashboard (`/maintenance`، صفحة البلاغ، إعداد الصيانة → SLA، `/sla-report`، صفحة الأصل، `/warranty-claims`، `/plan-calendar`)
> **الصلاحيات:** `tickets.dispatch` لأوامر الشغل وحركات التوزيع والقائمة وتقرير الـSLA؛ `maintenance.manage` لمستويات التصعيد؛ `assets.read` للسجل والتقويم؛ `assets.manage` للضمان والمطالبات.
> **المصادر:** ADR 0076 · `src/maintenance/tickets/work-orders.service.ts`، `src/maintenance/sla/sla-at-risk.ts`، `src/maintenance/assets/warranty-claims.service.ts`

## أمر شغل من الإدارة
- `POST /maintenance/work-orders { assetId | commonAreaId, categoryId, priority?, description, meterAlertId? }`: عطل اتشاف في جولة، جهاز، ارتفاع في عداد. البلاغ أصله `staff`، المُبلّغ هو اللي فتحه، ويتوزع ويتقاس زي أي إصلاح.
- من تنبيه عداد: التنبيه بيتأكد معاه، وأمر شغل واحد بس للتنبيه (`409 METER_ALERT_HAS_WORK_ORDER {ticketNumber}`). من غير مكان، مكان العداد.
- لو على أصل جوه وحدة: الأسرة بتشوفه (الفني لازم يدخل)، زي عطل الفني.

## حركات التوزيع
- **إقفال للساكن:** `POST /maintenance/tickets/:id/close { reasonCode }` (`ticketStaffClose`) على بلاغ ساكن مكتمل: أكد بالتليفون، مايترد، ساب الكمبوند. الحالة `closed_by_staff`، والساكن بيتبلغ ويقدر يفتحه في مدته. أمر شغل الكمبوند بيتقبل بدل ما يتقفل (`409 TICKET_NOT_RESIDENTS`).
- **إعادة فتح:** `POST …/reopen { reasonCode, reason }` على بلاغ مقفول في خلال ٣٠ يوم (`409 TICKET_REOPEN_WINDOW_PASSED {reopenDays: 30}`). أول مرة يرجع للفني، بعدها للطابور. الكلام بيروح للمحادثة.
- **استكمال:** `POST …/resume` على بلاغ متوقف: يرجع شغال في إيد الفني، بنفس شروط استكماله هو (التصريح وتأكيد تعليمات السلامة بتوعه).

## القائمة والتصدير
- `GET /maintenance/tickets?buildingId=…&q=…`: المبنى (من سجل المباني، ADR 0072: وحداته والمساحات اللي بتسميه)، والبحث برقم البلاغ أو أول كود الوحدة.
- `GET /maintenance/tickets/export?from&to&…`: CSV بنفس الفلاتر، أيام الإنشاء لحد ٣٦٦ يوم. أكواد وأرقام بس، من غير كلام حد.

## الـSLA
- **مستويات التصعيد:** `PATCH /maintenance/sla-settings/escalation { normal?, urgent?, emergency? }`: نسبة من الهدف (٥٠–٩٥، ٧٥ افتراضي، أو فاضي = من غير تنبيه). الساعة اللي عدّت النسبة: الفني والمشرفين بيتبلغوا مرة (`ticket.sla_at_risk`)، وعند الهدف نفسه الإدارة كمان (التجاوز).
- **التقرير:** `GET /maintenance/sla-report?from&to`: اتحقق ولا اتجاوز، بالفئة والأولوية والساعة، والنسبة، والإجمالي؛ و`…/export` CSV.

## سجل الأصل والضمان
- `GET /maintenance/assets/:id/timeline`: كل اللي حصل للأصل في قائمة واحدة، الأحدث الأول: أحداثه، بلاغاته (اتفتح، اتعمل إيه، اتقفل)، القطع، التكاليف، ومطالبات الضمان.
- الكارت: بداية الضمان، الضامن، اللي بيغطيه (`ENDS_BEFORE_START` لو البداية بعد النهاية).
- **المطالبات:** `POST /maintenance/warranty-claims { assetId, ticketId?, description }` والضمان ساري (`ASSET_NO_WARRANTY`، `WARRANTY_EXPIRED {endsOn}`)؛ واحدة مفتوحة لكل بلاغ؛ `PATCH /:id { reference }`؛ ثم `accept { recoveredAmount? }` أو `reject { reasonCode }` أو `withdraw { reasonCode }`، مرة واحدة (`409 WARRANTY_CLAIM_DECIDED`).

## تقويم الشغل المخطط
- `GET /maintenance/plan-calendar?from&to` (لحد ٩٣ يوم): تواريخ كل الخطط، اللي اتفتحت أوامر شغل (حالتها) واللي جاية (`projected`).
