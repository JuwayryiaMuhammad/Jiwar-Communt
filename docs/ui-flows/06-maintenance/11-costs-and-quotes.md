# تكاليف البلاغ، اللي اتعمل، وعرض السعر من الفني

> **التطبيق/الواجهة:** manager dashboard · technician app
> **الصلاحيات:** التكاليف والقرار `tickets.dispatch`، الفني `tickets.work`.
> **المصادر:** ADR 0065 · `src/maintenance/costs/` · `src/maintenance/quotes/`

## التكاليف — `/maintenance/tickets/:id/costs`
- `GET`: البنود من الأقدم + الإجمالي (عمالة، مقاول، قطع، أخرى). البنود الملغية مش محسوبة.
- `POST { kind: labour|contractor|other, description, quantity, unitAmount }`: المبلغ = الكمية × سعر الوحدة لأقرب قرش. (+ `Idempotency-Key`)
- `POST /maintenance/ticket-costs/:id/void { reasonCode }` (`ticketCostVoid`): مرة واحدة ومابيتعدلش. بند القطعة مابيتلغيش (`409 TICKET_COST_ENTRY_IS_PART`) — المرتجع هو اللي بيلغيه.
- لحد ٢٠٠ بند للبلاغ. الساكن مابيشوفش التكاليف.

## اللي اتعمل — وقت الإتمام
- `POST /technician/tickets/:id/complete { actionCode?, note? }`: `actionCode` من `ticketCompletionAction`؛ الملاحظة محتاجة كود.
- الفني والتوزيع بيشوفوا الكود والملاحظة (`completion`)؛ الساكن الكود بس (`completionAction`).

## عرض سعر من الفني
- الفني: `POST /technician/tickets/:id/quote-suggestions { amount, note? }`: على بلاغ ساكن في وحدة قبل ما الشغل يبدأ (زي عرض السعر بالظبط)، واحد مستني في المرة. التوزيع بيتبلّغ.
- التوزيع: `GET /maintenance/tickets/:id/quote-suggestions` · `POST /maintenance/quote-suggestions/:id/send { amount?, note? }` (بيبقى عرض سعر للسكان زي ADR 0058) · `POST .../dismiss { reasonCode }` (`quoteSuggestionDismiss`، الفني بيتبلّغ بالسبب).
- القرار مرة واحدة؛ الساكن مابيشوفش الاقتراح، بيشوف العرض بس.
