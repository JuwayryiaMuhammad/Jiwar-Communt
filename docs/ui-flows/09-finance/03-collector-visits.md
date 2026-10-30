# زيارة المحصّل — Collector visits

> **التطبيق/الواجهة:** تطبيق الساكن؛ تطبيق المحصّل؛ لوحة المدير
> **الصلاحيات:** الطلب: `financePay`؛ التوزيع: `finance.payments`؛ المحصّل: `finance.collect`
> **المصادر:** ADR 0069 · `src/finance/collector`

## الساكن
- `POST /units/:unitId/collector-visits { windowStartsAt, windowEndsAt, expectedAmount? }`: من بكرة، لحد ١٤ يوم، من ساعة لأربع ساعات. زيارة واحدة مفتوحة للوحدة.
- بيتبلغ لما تتوزع (`collector_visit.scheduled`) ولما تفشل (`collector_visit.failed`)؛ لو المحصّل عرض ميعاد تاني: `POST /collector-visits/:id/accept-offer` مرة واحدة.

## الإدارة — `/finance/collector-visits`
- توزيع على محصّل (`GET /staff/collectors`) أو إلغاء بسبب. هامش المحصّل (افتراضي ٥٠ جنيه، من ٠ لـ١٠٠٠).

## المحصّل — `/collector/visits`
- بيشوف الوحدة والعمارة والميعاد والمبلغ المتوقع بس: لا تليفون ولا اسم ولا رصيد.
- `…/collected { amount }`: دفعة كاش بإيصالها، لحد اللي على الوحدة + الهامش، وإلا `400 AMOUNT_TOO_HIGH {max}`؛ الزيادة رصيد للوحدة.
- `…/failed { reasonCode, offeredStartsAt?, offeredEndsAt? }`.
