# سجل الأصول والمناطق المشتركة — Asset register

> **التطبيق/الواجهة:** manager dashboard · technician app (القراءة في الموقع)
> **الصلاحيات:** القراءة: `assets.read` (الفني، المشرف، المدير). الإدارة: `assets.manage` (المشرف، المدير).
> **المصادر:** ADR 0064 · `src/maintenance/locations/` · `src/maintenance/assets/`

## الفكرة باختصار
كل معدة في الكمبوند (مضخة، مولد، مصعد، إنارة…) ليها كارت: هي فين، نوعها، الضمان، القيم، حالتها، صحتها، وتاريخها.
الأصل يا إما في وحدة يا إما في **منطقة مشتركة** (مبنى كامل، حديقة، سطح، غرفة مضخات، أو مرفق).
الأصول ممكن تتداخل لحد ٤ مستويات: مبنى ← نظام ← أصل ← مكوّن، والجزء دايماً في نفس مكان الأصل اللي هو جزء منه.
كل أصل ومنطقة ليه **تاج QR** يتطبع ويتلزق، والفني يمسحه لما يوصل.

## المناطق المشتركة — `/maintenance/areas`
- `GET /maintenance/areas?kind=&active=` (paged، الأقدم الأول) · `GET /maintenance/areas/:id`.
- `POST /maintenance/areas` (+ `Idempotency-Key`): `kind` = `building` | `area` | `facility`، `code` (فريد، ما يتغيرش)، `nameAr`, `nameEn`، و:
  - `building` إجباري لنوع `building` (نفس اسم المبنى زي ما في الوحدات؛ لازم يكون فيه وحدة واحدة على الأقل → وإلا `BUILDING_NOT_FOUND`)، واختياري لنوع `area`، وممنوع لنوع `facility`.
  - `facilityId` إجباري لنوع `facility` وممنوع للباقي. مرفق مش موجود = `409 RELATED_RESOURCE_MISSING`.
  - `latitude` + `longitude` مع بعض أو لأ.
  - مبنى أو مرفق ليه صف واحد بس → التاني `409 DUPLICATE_RESOURCE` على `building` أو `facilityId`.
- `PATCH /maintenance/areas/:id`: الأسماء، `building` (لنوع `area` بس؛ `null` يمسحه)، الموقع (`null` + `null` يمسحه)، `active: false` = إيقاف (ما يتمسحش أبداً).
- `POST /maintenance/areas/:id/tag` → `{ code, issuedAt }` **مرة واحدة**، `no-store`: اطبعه دلوقتي. التاج القديم بيبطل في نفس اللحظة. منطقة موقوفة = `409 COMMON_AREA_RETIRED`.

## أنواع الأصول — في إعدادات الصيانة
- `GET /maintenance/asset-types` · `POST` (`key`, الأسماء, `categoryId` = فئة الفنيين اللي بيشتغلوا عليه, `expectedLifeYears`) · `PATCH /:id` (من غير `key`؛ `active: false` = إيقاف).
- كل كمبوند جديد بيبدأ بـ: hvac, pump, water_tank, irrigation, pool_equipment, generator, electrical_panel, lighting, elevator, fire_system, gate_barrier, meter.

## الأصول — `/maintenance/assets`
- `GET /maintenance/assets?status=&typeId=&unitId=&commonAreaId=&parentId=&criticality=` (paged، الأحدث الأول).
- `POST /maintenance/assets` (+ `Idempotency-Key`): `code`, `typeId` (نوع شغال)، `nameAr`, `nameEn`، ومكان واحد بس:
  - `commonAreaId` أو `unitId` لأصل رئيسي؛
  - أو `parentId` لجزء (من غير مكان: بياخد مكان الأب). أعمق من ٤ = `ASSET_TOO_DEEP`.
  - اختياري: `manufacturer`, `model`, `serialNumber`, `commissionedOn`, `purchaseValue`, `replacementCost`, `downtimeCostPerDay`, `expectedLifeYears`, `vendorName`, `vendorPhone`, `warrantyEndsOn`, `criticality`, `condition`, `servesBuildings[]`.
- `GET /maintenance/assets/:id` = **الكارت**: النوع، المكان (كود الوحدة أو المنطقة)، العمر، الضمان (`underWarranty`)، عدد الأجزاء، و**الصحة** `{ score 0–100, band: good | watch | poor }` (محسوبة بقاعدة؛ `null` لو متقاعد).
- `PATCH /:id`: بيانات الكارت بس (الكود والنوع والأب والمكان ما يتغيروش من هنا). أي حقل اختياري `null` يمسحه.
- `POST /:id/status` `{ status: in_service | out_of_service, reasonCode? }`: خارج الخدمة لازم سبب من `assetOutOfService`.
- `POST /:id/move` `{ commonAreaId | unitId }`: للأصل الرئيسي بس (جزء = `409 ASSET_NOT_ROOT`)، وبينقل كل أجزائه معاه.
- `POST /:id/retire` `{ reasonCode }` من `assetRetire`: نهائي. لازم الأجزاء تتقاعد الأول (`409 ASSET_HAS_ACTIVE_CHILDREN`). خططه بتقف معاه.
- `POST /:id/tag` → `{ code }` مرة واحدة (`no-store`).
- `GET /:id/events` (تاريخ الأصل بالأكواد) · `GET /:id/impact` (المباني اللي بيخدمها، عدد الوحدات والمسكونة منها؛ أرقام بس).

## المستندات — `/maintenance/documents`
- `GET /maintenance/documents?assetId=|assetTypeId=|commonAreaId=` (واحد بس) → كل مستند بـ `url` مؤقت (`no-store`).
- `POST /maintenance/documents` (`asset_document` file + `kind`: plan, manual, warranty, certificate, photo, other + `title`). ٥٠ مستند بالكتير لكل حاجة.
- `POST /maintenance/documents/:id/remove`: مرة واحدة؛ الملف بيتمسح.

## الاستيراد من شيت — `/maintenance/asset-imports`
1. ارفع CSV (`data_import`, UTF-8، ١ ميجا، ٢٠٠٠ صف) → `POST /maintenance/asset-imports { fileId }`.
2. الرد `{ status: valid | invalid, rowCount, errorCount, errors[] }` — كل مشكلة `{ line, field, code }` (السطر والعمود والكود؛ **مش النص**). شيت مش CSV سليم = `422 ASSET_IMPORT_UNREADABLE` (`params.problem`, `params.line`).
3. لو `valid`: `POST /maintenance/asset-imports/:id/apply` → كل الصفوف أو ولا صف. لو حاجة اتغيرت من ساعة الفحص (كود اتاخد، منطقة اتوقفت) الرد بيرجع `status: invalid` بالمشاكل. مرة واحدة بس (`409 ASSET_IMPORT_NOT_VALID`).
- الأعمدة: `code, type, name_ar, name_en` إجباري؛ ومكان: `unit` (كود وحدة) أو `area` (كود منطقة) أو `parent` (كود أصل في السجل أو في سطر قبله)؛ اختياري: `manufacturer, model, serial_number, commissioned_on, purchase_value, replacement_cost, downtime_cost_per_day, expected_life_years, vendor_name, vendor_phone, warranty_ends_on, criticality, condition, serves_buildings` (مفصولة بـ `;`).

## الإشعارات
- `asset.warranty_expiring` `{ assetRef, endsOn }`: للي ماسكين السجل، مرة لكل تاريخ انتهاء، قبلها بـ ٣٠ يوم.
- `asset.replacement_recommended` `{ assetRef }`: فني بيوصي بالاستبدال (راجع `05-technician-app.md`).
