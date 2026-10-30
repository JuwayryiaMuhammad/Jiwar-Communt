# الاستعداد للمواسم والفعاليات — Readiness programs

> **التطبيق/الواجهة:** manager dashboard (`/readiness`)، وأي ستاف عنده بند (`/staff/readiness-items`)
> **الصلاحيات:** `readiness.manage` (المشرف والمدير). صاحب البند بيقفل بنده من غير صلاحية.
> **المصادر:** ADR 0067 · `src/maintenance/readiness/`

## البرنامج
- `POST /maintenance/readiness/programs { kind, title, startsOn, endsOn }` (+ `Idempotency-Key`): `season | event | emergency`. الأيام بتتكتب (رمضان والعيد بيتحركوا)، سنة ويوم بالكتير. العنوان ١–١٢٠ حرف بعد الـtrim.
- `GET …/programs?kind=&open=` (الأحدث بداية الأول) و`GET …/programs/:id`: كل برنامج معاه `readiness { items, done, cancelled, open, percent, budget }`. النسبة = المنجز ÷ (الكل − الملغي)، والميزانية = تقديرات البنود اللي مااتلغتش (EGP).
- `PATCH …/programs/:id { title?, startsOn?, endsOn? }` وهو مفتوح؛ النهاية مش قبل آخر ميعاد بند (`READINESS_ITEMS_DUE_LATER {dueOn}`).
- `POST …/programs/:id/close`: مرة واحدة، وبعدها ولا البرنامج ولا بنوده بيتغيروا (`409 READINESS_PROGRAM_CLOSED`).
- `POST …/programs/:id/copy { startsOn }` (+ `Idempotency-Key`): من النهارده. كل الأيام بتتحرك بنفس الفرق. المهام والتقديرات والحملات بتتنسخ مفتوحة؛ مراجعات العقود والملغي لأ. اللي مابقاش ينفع يمسك بند، بنده بيروح للي نسخ، وبيرجع في `reassignedItemIds`. نسخ لنفس البداية تاني = `409 DUPLICATE_RESOURCE` على `startsOn` (نفس المفتاح بيرجّع نفس النسخة).

## البنود
- `POST …/programs/:id/items { kind, title, ownerId, dueOn, estimateAmount?, contractId?, checklistId? }` (+ `Idempotency-Key`):
  - `task` (تقدير اختياري)، `estimate` (التقدير إجباري)، `contract_review` (`contractId` إجباري)، `inspection_campaign` (`checklistId` إجباري). أي حقل مش لنوعه = `FIELD_NOT_ALLOWED`.
  - التقدير string بقرشين بالكتير وأكبر من صفر (`12500.50`) — عمره ما بيبقى float.
  - المالك ستاف أو المدير نشط (`READINESS_OWNER_NOT_ELIGIBLE`)، وبيوصله `readiness_item.assigned` باليوم بس.
  - الميعاد من النهارده لحد آخر يوم في البرنامج (`READINESS_DUE_AFTER_END {endsOn}`).
- `PATCH /maintenance/readiness/items/:itemId { title?, ownerId?, dueOn?, estimateAmount? }` وهو مفتوح؛ `estimateAmount: null` بيشيل تقدير المهمة.
- `POST …/items/:itemId/done { decision? }`: مرة واحدة. المراجعة لازم `decision` (`renew | replace | end`). الحملة بتخلص لوحدها (`409 READINESS_CAMPAIGN_AUTOMATIC`).
- `POST …/items/:itemId/cancel { reasonCode }` (`readinessItemCancel`): مرة واحدة. الحملة مش بتتلغي وفيها تفتيش مفتوح (`409 READINESS_CAMPAIGN_OPEN {open}`).
- البند اللي عدّى ميعاده: صاحبه بيتبلغ مرة (`readiness_item.overdue`).
- صاحب البند: `GET /staff/readiness-items` (بنودي المفتوحة) و`POST /staff/readiness-items/:itemId/done`.

## مراجعة العقود
- `GET …/programs/:id/contracts-due`: عقود الصيانة السارية اللي بتخلص قبل آخر يوم في البرنامج (ومش خلصت)، ومعاها البند لو موجود.
- العقد بيتراجع مرة في البرنامج إلا لو المراجعة اتلغت (`409 DUPLICATE_RESOURCE` على `contractId`)؛ عقد مش في القايمة = `CONTRACT_NOT_DUE_FOR_REVIEW`.

## حملة تفتيش
- `POST /maintenance/readiness/items/:itemId/campaign { inspectorId, assetIds?, commonAreaIds? }`: تفتيش لكل هدف، ميعاده ميعاد البند، للمفتش. الهدف أصل للكمبوند (مش جوه وحدة) أو منطقة مشتركة نشطة؛ الغلط بيتسمى بمكانه (`assetIds.0 ASSET_NOT_AVAILABLE`).
- الهدف مرة واحدة في الحملة: لو اتبعتت تاني (أو مرتين مع بعض) بيتضاف الجديد بس.
- `GET …/items/:itemId/campaign`: التفتيشات وحالتها. آخر تفتيش يتسلّم أو يتلغي = البند خلص.
