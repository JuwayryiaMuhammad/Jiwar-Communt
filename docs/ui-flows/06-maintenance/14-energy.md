# العدادات والاستهلاك — Meters and consumption

> **التطبيق/الواجهة:** manager dashboard، وتطبيق الفني للقراءة
> **الصلاحيات:** `energy.read` يقرا، `energy.manage` يمسك العدادات والتعريفات والإجراءات (المشرف والمدير)؛ الفني `meters.record` بس.
> **المصادر:** ADR 0066 · `src/maintenance/energy/`

استهلاك الوحدة بيبيّن هي فاضية ولا لأ، فالفني مابيشوفش الاستهلاك: بيشوف العداد اللي بيقراه بس.

## العدادات — `/maintenance/meters`
- `POST { code, kind, mode?, multiplier?, unitId | commonAreaId | assetId, serial?, installedOn? }` (+ `Idempotency-Key`). مكان واحد بس؛ على أصل = مكان الأصل. كود متكرر → `409 DUPLICATE_RESOURCE` على `code`.
- النوع: كهرباء (kWh)، مية (m³)، غاز (m³)، سولار (L)، ساعات تشغيل (h). الـmode: `cumulative` (العداد زي ما هو) أو `interval` (اللي اتصرف من آخر قراءة).
- النوع والـmode والمعامل والمكان مابيتغيروش أبدًا. عداد اتغيّر = يتقاعد ويتعمل جديد، أو قراءة `reset`.
- `PATCH /:id { serial?, installedOn? }` · `POST /:id/retire { reasonCode }` (`meterRetire`) مرة واحدة.

## القراءات — `/maintenance/meters/:id/readings`
- `POST { readOn, value, reset? }`: يوم من أيام الكمبوند، لحد النهارده، ولحد ٤٠٠ يوم ورا. قراءة واحدة حية في اليوم (`409 READING_EXISTS` ومعاها `readingId`).
- العداد التراكمي بيتراجع على القراءتين اللي حواليه: أقل من اللي قبله → `READING_BELOW_PREVIOUS`، أكبر من اللي بعده → `READING_ABOVE_NEXT`. القراءة الـ`reset` بتقطع المقارنة من ناحيتها.
- `POST /:readingId/correct { value, readOn?, reset?, reasonCode }` (`readingCorrect`): قراءة جديدة بتحل محلها، مرة واحدة (`409 READING_ALREADY_CORRECTED`). `POST /:readingId/withdraw { reasonCode }`: تتشال من غير بديل.
- `GET …?superseded=true` يجيب المصححة كمان.
- **استيراد:** `POST /maintenance/meter-reading-imports { fileId }` لملف CSV فيه `meter,read_on,value,reset`؛ بيتفحص كله (المشاكل بالسطر والعمود والكود، من غير محتوى الخلية)، و`POST /:id/apply` مرة واحدة، كله أو ولا حاجة.

## الاستهلاك — `/maintenance/energy/consumption`
- `GET ?kind=&groupBy=building|area|meter&from=&to=`: محسوب وقت الطلب من القراءات الحية. كل فترة بين قراءتين بتتوزع على أيامها بالتساوي، والجزء اللي جوه الفترة المطلوبة بيتحسب بالشهر وبالتعريفة اللي سارية كل يوم.
- كل مجموعة: الاستهلاك، التكلفة، لكل متر مربع، ولكل وحدة ساكنة (للمقارنة بين العماير). `…/export` = نفس الكلام CSV.
- عداد واحد بالشهر: `GET /maintenance/meters/:id/consumption?from=&to=`.

## الارتفاع المفاجئ
- على آخر قراءة حية بس: استهلاك اليوم في الفترة أكبر من متوسط الفترات اللي قبلها × المعامل (افتراضي ٢، و٦ فترات؛ `PATCH /maintenance/energy/settings`). محتاج ٣ فترات على الأقل.
- مرة واحدة للعداد في اليوم، بيروح لأصحاب `energy.manage` (`meter.anomaly`)، و`POST /maintenance/meter-alerts/:id/acknowledge` مرة واحدة.

## التعريفات وإجراءات التوفير
- `POST /maintenance/energy/tariffs { kind, effectiveOn, pricePerUnit }`: مابتتعدلش، اللي بعدها بتاخد مكانها. واحدة للنوع في اليوم (تانية → `409 DUPLICATE_RESOURCE` على `effectiveOn`).
- `POST /maintenance/energy/measures { title, kind, meterId? | building?, startsOn, cost? }` · `GET /:id?weeks=` = الأثر: الاستهلاك في اليوم في أسابيع كاملة قبل البداية مقابل نفس عدد الأسابيع من البداية · `POST /:id/end { endedOn }` مرة واحدة.

## الفني
- `GET /technician/meters/:id`: العداد، آخر قراءة، والمدى المتوقع للنهارده. `POST /technician/meters/:id/readings { readOn, value, reset? }` بنفس القواعد.
