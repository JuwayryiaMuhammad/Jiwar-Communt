# منع الحجز واستخدام المرافق — Facility bans and use

> **التطبيق/الواجهة:** manager dashboard (`/facility-bans`، `/facility-usage`)، وتطبيق الساكن
> **الصلاحيات:** `bookings.handle` للمنع؛ `facilities.manage` أو `bookings.handle` للتقرير؛ `facilities.book` للساكن يشوف منعه.
> **المصادر:** ADR 0067 · `src/facilities/bans/`، `src/facilities/usage/`

## المنع
- `POST /staff/facility-bans { accountId, facilityId?, reasonCode, endsOn? }` (+ `Idempotency-Key`): حساب ساكن أو فرد أسرة نشط (`BAN_ACCOUNT_NOT_ELIGIBLE`)، من مرفق واحد أو كل المرافق، لحد يوم (شامل، في خلال سنة) أو لحد ما يترفع. السبب من `facilityBan`.
- **بيلغي** حجوزات الحساب اللي في النطاق ولسه ما بدأتش (مستنية أو مؤكدة)، زي ما الستاف بيلغي: `cancelReason: facility_ban`، والحاجز بيوصله `booking.cancelled_by_staff`. الرد فيه `cancelledBookingIds`.
- واحد ساري لكل حساب ونطاق (`409 FACILITY_BAN_EXISTS {banId}`)؛ اللي خلص بيتقفل لوحده لما الجديد يبدأ.
- `POST /staff/facility-bans/:id/lift { reasonCode }` (`facilityBanLift`): مرة، وهو ساري (`409 FACILITY_BAN_OVER {state}`).
- الحجز بعدها: `403 FACILITY_BANNED {facilityId?, until?}` — بعد الصلاحية، وإيقاف الوحدة، والمرفق. الدخول من غير حجز والنادي مش بيتأثروا.
- الساكن: `GET /me/facility-bans`، وإشعار `facility_ban.started` / `.lifted` (النطاق واليوم، مش السبب)، وكل منع ليه في تصدير بياناته.

## استخدام المرافق
- `GET /staff/facility-usage?from=&to=` (٣٠ يوم لحد النهارده، سنة ويوم بالكتير) و`/export` (CSV): لكل مرفق بالحجز: الحجوزات بالحالة، دقايق الفتح (الساعات ناقص الغلق)، الدقايق المحجوزة، الاستخدام %، نسبة عدم الحضور، ونصيب الذروة.
