# التفتيش الميداني — Field inspections

> **التطبيق/الواجهة:** manager dashboard (الجولات والتقرير) · technician app (التنفيذ)
> **الصلاحيات:** الإدارة `inspections.manage` (المشرف، المدير)، التنفيذ `inspections.perform` (الفني).
> **المصادر:** ADR 0064 · `src/maintenance/inspections/` · `src/maintenance/checklists/`

## الفكرة باختصار
تفتيش = قائمة فحص على مكان (منطقة مشتركة أو أصل مش في وحدة) لمفتش في يوم.
**الجولة** بتعيد التفتيش على التقويم (كل أسبوع مثلاً) وبتفتحه قبل ميعاده بيومين.
المفتش بيبدأ، وبيمسح تاج المكان لو القائمة طالبة كده، بيجاوب، ويسلّم مرة واحدة: كل بند فاشل مطلوب له متابعة بيفتح **أمر عمل** للمكان.

## قوائم الفحص — في إعدادات الصيانة
- `GET /maintenance/checklists` · `GET /:id` · `POST` (`key`, الأسماء, `purpose`: pm/inspection/any, `requireScan`, `items[]`) · `PATCH /:id` · `PUT /:id/items` (بنود جديدة = **نسخة جديدة**؛ اللي شغالين بيكملوا على نسختهم).
- البند: `kind` = `check` (مطابق/غير مطابق/لا ينطبق) | `reading` (رقم، `metricKey`, `unit`, `minValue`/`maxValue`: برا المدى = فشل) | `photo` | `text`؛ `required`؛ `failCreatesTicket` + `followUpCategoryId` + `followUpPriority` (للفحص أو القراءة بس).

## الجولات والتفتيشات (الإدارة)
- `GET/POST /maintenance/inspection-rounds` · `GET/PATCH /:id` · `POST /:id/deactivate|reactivate`.
- `GET /maintenance/inspections?status=&assigneeId=&roundId=&assetId=&commonAreaId=` · `POST` (تفتيش لوحده: `checklistId`, `assigneeId`, `dueOn`, مكان) · `GET /:id` (القائمة بإجاباتها، والمتابعات) · `POST /:id/cancel { reasonCode }` (`inspectionCancel`).
- التقرير: `GET /maintenance/inspection-report?from=&to=` (لحد ٣٦٦ يوم) → الإجماليات (اتعمل، في الميعاد، مفتوح، متأخر، اتلغى، بنود فشلت، متابعات اتقفلت ونسبتها) والصفوف؛ و`GET /maintenance/inspection-report/export` = CSV (`no-store`، عبر الـBFF).

## المفتش — `/technician/inspections`
1. `GET /technician/inspections?status=` (بتاعتي بس) · `GET /:id`.
2. `POST /:id/start { code? }`: يبدأ. لو القائمة `requireScan`: لازم `code` = التاج **الحالي** للمكان (قديم أو مكان تاني = `409 INSPECTION_TAG_MISMATCH`). المسح ممكن يجي بعد البداية بنفس الطلب.
3. `PUT /:id/items/:itemId { result? | value? , note?, photoFileIds? }` (صور `checklist_photo`، ٣ بالكتير) — يتعدل لحد التسليم. قبل البداية = `409 INSPECTION_NOT_STARTED`.
4. `POST /:id/submit`: كل البنود المطلوبة متجاوبة (وإلا `409 CHECKLIST_INCOMPLETE` بـ`params.positions`)، والمسح لو مطلوب (`409 INSPECTION_SCAN_REQUIRED`). بيتخزن SHA-256 للإجابات (= توقيع المفتش)، وكل بند فاشل بيفتح أمر عمل `origin: inspection`.
- بعد التسليم أو الإلغاء = `409 INSPECTION_ENDED`.

## الإشعارات
- `inspection.assigned` `{ targetRef, dueOn }`: للمفتش.
- `inspection.overdue` `{ targetRef, dueOn }`: للمفتش واللي بيديروا التفتيش، مرة واحدة بعد اليوم.
