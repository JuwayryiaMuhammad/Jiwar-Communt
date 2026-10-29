# عقود الصيانة — Maintenance contracts

> **التطبيق/الواجهة:** manager dashboard
> **الصلاحيات:** `assets.manage` (اللي بيمسك السجل)، والفني بيشوف مين يكلّم بـ`assets.read`.
> **المصادر:** ADR 0065 · `src/maintenance/contracts/`

- `POST /maintenance/contracts { code, kind, vendorName, vendorPhone?, scope?, startsOn, endsOn, annualValue?, noticeDays? }` (+ `Idempotency-Key`). التواريخ لازم تكون حقيقية والنهاية بعد البداية. كود متكرر → `409 DUPLICATE_RESOURCE` على `code`.
- `GET /maintenance/contracts?status=&assetId=` — الحالة من تواريخه على يوم الكمبوند: `upcoming` / `active` / `ended`، أو `terminated`.
- `PATCH /:id`: الشروط (مش بعد الإنهاء). تغيير تاريخ النهاية = بيتعلن من جديد.
- `PUT /:id/assets { assetIds }`: الأصول اللي بيغطيها، بتتبدل كلها؛ أصل متقاعد مرفوض.
- `POST /:id/terminate { reasonCode }` (`contractTerminate`): مرة واحدة، وبعدها مابيتغيرش.
- ورق العقد: `POST /maintenance/documents { contractId, fileId, kind, title }`.
- الفني: `GET /maintenance/assets/:id/contracts` = العقود الشغالة على الأصل (من غير فلوس).
- قبل النهاية بـ`noticeDays`: إشعار مرة واحدة لكل تاريخ نهاية (`maintenance_contract.expiring`).
