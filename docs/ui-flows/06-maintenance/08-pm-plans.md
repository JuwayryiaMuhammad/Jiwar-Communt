# الصيانة المخططة — Maintenance plans

> **التطبيق/الواجهة:** manager dashboard · technician app (المهام الجاية)
> **الصلاحيات:** القراءة `assets.read`، الإدارة `assets.manage`.
> **المصادر:** ADR 0064 · `src/maintenance/plans/` · `src/maintenance/schedules/`

## الفكرة باختصار
خطة على أصل (مش في وحدة): كل فترة (أو كل ما العداد يعدي رقم) بيتفتح **أمر عمل** للأصل قبل ميعاده بكام يوم، بيروح لفنيين فئة الأصل، ومعاه **قائمة الفحص**.
الفني لما يخلص بيتسجل "تم" — في الميعاد لو قبل `الميعاد + أيام السماح`. بعد السماح المالك والمشرفين بيوصلهم إشعار مرة واحدة.

## إنشاء خطة — `POST /maintenance/plans` (+ `Idempotency-Key`)
- `assetId` (أصل شغال، مش في وحدة → وإلا `409 PLAN_FOR_UNIT_ASSET`)، `title` (كلام أمر العمل)، `trigger`:
  - `calendar`: `every` (١–٣٦٥) + `unit` (day/week/month/year) + `anchorOn` + `basis` (`fixed` = مواعيد ثابتة، الشهر بيحافظ على اليوم ولو آخر الشهر بيتقص؛ `floating` = فترة بعد يوم ما اتعمل آخر مرة).
  - `usage`: `metricKey` (زي `run_hours`) + `usageInterval`: بيستحق لما القراءات تزيد بالقيمة دي من آخر صيانة.
- اختياري: `checklistId` (قائمة لـ`pm` أو `any`)، `categoryId` (افتراضياً فئة النوع)، `priority`، `leadDays` (٧)، `graceDays` (٣)، `ownerId` (افتراضياً اللي بينشئ؛ لازم يكون بيوزّع بلاغات → وإلا `PLAN_OWNER_NOT_ELIGIBLE`).

## إدارة الخطة
- `GET /maintenance/plans?assetId=&active=` · `GET /:id` (فيها `stats`: done, onTime, overdue, open) · `GET /:id/occurrences` · `GET /:id/events`.
- `PATCH /:id`: سلسلة جديدة بتعيد حساب الميعاد الجاي من النهارده.
- `POST /:id/defer { toDate, reasonCode }` (`planDefer`، لحد سنة): يأجل الميعاد اللي لسه ما اتفتحش.
- `POST /:id/skip { reasonCode }` (`planSkip`): يفوّته ويتسجل.
- `POST /:id/deactivate { reasonCode }` (`planDeactivate`) · `POST /:id/reactivate`.
- `POST /maintenance/plan-occurrences/:id/defer { toDate, reasonCode }`: يأجل ميعاد اتفتح أمر عمله.

## اللي بيحصل لوحده
- كل ربع ساعة: الخطط اللي ميعادها جوه أيام الفتح بيتفتح لها أمر عمل **مرة واحدة** للميعاد (حتى لو الـsweep اشتغل مرتين في نفس الوقت)، وبيتعرض على التوزيع.
- إتمام أمر العمل = الميعاد "تم" (في الميعاد أو متأخر). إلغاؤه = الميعاد "اتلغى"، والخطة العائمة بتكمل من يومها.
- أمر عمل الخطة: `origin: plan`، ما بيظهرش لأي ساكن، من غير SLA ومن غير عرض سعر؛ المشرف بيقبل الشغل (`accept-work`) أو يرجّعه (`send-back`).
- تقاعد الأصل بيوقف خططه.

## الإشعارات
- `maintenance.plan_overdue` `{ assetRef, dueOn }`: للمالك وكل اللي بيوزعوا، مرة واحدة.
