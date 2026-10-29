# المخزن وطلبات القطع — Stock and part requests

> **التطبيق/الواجهة:** manager dashboard · technician app
> **الصلاحيات:** المخزن `stock.manage` (مشرف الصيانة والمدير)، الفني `tickets.work`.
> **المصادر:** ADR 0065 · `src/maintenance/stock/`

## الفكرة باختصار
المخزن فيه **أصناف** (SKU، اسم، وحدة، حد إعادة الطلب) و**مخازن**. كل حركة (استلام، تسوية، تحويل، صرف لبلاغ، مرتجع) بتتسجل ومابتتعدلش. الرصيد عمره ما ينزل تحت صفر ولا تحت المحجوز.
الفني بيطلب قطعة على بلاغه وهو شغال عليه؛ المخزن **يحجزها** في مخزن، وبعدين **يصرفها** (بتتسجل على تكاليف البلاغ بمتوسط التكلفة) أو **يرفض** بسبب.

## المخزن — `/maintenance/stores`، `/maintenance/stock/items`
- `POST /maintenance/stores { code, nameAr, nameEn, commonAreaId? }` · `PATCH /:id { nameAr?, nameEn?, active? }` (الإيقاف بيسيب الرصيد زي ما هو، بس مفيش حركة).
- `POST /maintenance/stock/items { sku, nameAr, nameEn, unit, reorderLevel? }` · `PATCH /:id { reorderLevel? (null = من غير تنبيه), active? }`.
- كود مخزن أو SKU متكرر في نفس الكمبوند → `409 DUPLICATE_RESOURCE` على `code` أو `sku`.
- `GET /maintenance/stock/items?below=true` = الأصناف اللي وصلت حد إعادة الطلب. `GET /:id` = الرصيد في كل مخزن.
- `POST /:id/receive { storeId, quantity, unitCost, reference? }`: بيزوّد الرصيد ويحرّك **متوسط التكلفة**.
- `POST /:id/adjust { storeId, delta, reasonCode }` (`stockAdjust`): زيادة أو نقص بسبب.
- `POST /:id/transfer { fromStoreId, toStoreId, quantity }`: حركتين بنفس `transferId`.
- `GET /maintenance/stock/movements?itemId=&storeId=&ticketId=`.
- لو الكمية مش موجودة (أو محجوزة) → `409 STOCK_INSUFFICIENT` ومعاه `available`.
- **تنبيه إعادة الطلب** بيروح مرة واحدة لما الرصيد يوصل الحد، وبيتشال لما يعلى عنه، وبيرجع يتبعت في النزلة الجاية.

## طلبات القطع
- الفني: `GET /technician/stock/items?q=` (بيقول فيه ولا لأ، من غير كمية ولا مكان) · `POST /technician/tickets/:id/part-requests { itemId, quantity }` (والبلاغ في إيده بس) · `POST /technician/part-requests/:id/cancel { reasonCode }` (`partRequestCancel`، قبل الصرف) · `POST /technician/tickets/:id/part-returns { itemId, storeId, quantity }` (لحد اللي اتصرف للبلاغ ناقص اللي رجع) · `GET /technician/tickets/:id/parts`.
- المخزن: `GET /maintenance/part-requests?status=` · `POST /:id/reserve { storeId }` (بيتبلّغ الفني) · `POST /:id/issue` · `POST /:id/decline { reasonCode }` (`partRequestDecline`، بيتبلّغ الفني).
- إلغاء البلاغ بيلغي طلباته المفتوحة ويفك الحجز.
