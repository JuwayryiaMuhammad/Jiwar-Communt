# انقطاع المرافق — Utility outages

> **التطبيق/الواجهة:** manager dashboard، وتطبيق الساكن للإشعار
> **الصلاحيات:** `energy.read` يقرا، `energy.manage` يسجّل (المشرف والمدير).
> **المصادر:** ADR 0066 · `src/maintenance/outages/`

- `POST /maintenance/outages { kind, planned, scope, buildings?, startsAt, endsAt, note? }` (+ `Idempotency-Key`): مية، كهرباء، غاز أو غيره. `scope: compound` = الكمبوند كله ومن غير ولا عمارة؛ `scope: buildings` = عمارة لحد ٥٠ (غير كده `buildings` FIELD_NOT_ALLOWED أو FIELD_REQUIRED). البداية والنهاية بالـoffset، أسبوعين بالكتير، وسنة قدام بالكتير.
- **مين بيتبلغ:** كل ساكن وفرد أسرة نشط في وحدة في العماير دي (`utility_outage.announced`، تصنيف `utilities`). الإشعار فيه النوع والميعاد بس، مش الملاحظة.
- **إمتى:** المخطط له قبلها بـ**٤٨ ساعة** (الـsweep)؛ لو مش مخطط أو هيبدأ قبل كده: فورًا. كل واحد اتبلغ بيتسجل.
- `PATCH /:id { scope?, buildings?, startsAt?, endsAt?, note? }`: البداية بتتغير قبل ما تبدأ بس، وبيتبلغ بيها اللي اتبلغوا مرة واحدة (`utility_outage.rescheduled`)؛ عماير جديدة = إعلان لسكانها.
- `POST /:id/cancel { reasonCode }` (`outageCancel`) قبل البداية، و`POST /:id/end` بعدها: مرة واحدة، واللي اتبلغوا بس هم اللي بيعرفوا. بعدها مابيتغيرش.
- الساكن: `GET /me/outages` = اللي اتبلغ بيها ولسه ماخلصتش.
