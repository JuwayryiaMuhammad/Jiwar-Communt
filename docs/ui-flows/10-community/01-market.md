# السوق — The market

> **التطبيق/الواجهة:** تطبيق الساكن وفرد الأسرة؛ لوحة المدير `/market`
> **الصلاحيات:** الساكن: `market.post`؛ الإدارة: `market.handle`
> **المصادر:** ADR 0071 · `src/neighbours/market` · `src/neighbours/conversations`

## الساكن — الإعلانات
- `POST /market/listings { kind, category, title, body, price?, negotiable?, photoFileIds?, shopId?, fromUnitId? }`: بيع، هدية، مطلوب، خدمة. السعر لازم للبيع وممنوع على الهدية. لحد ٦ صور (`market_listing_photo`، ٥ ميجا)، كل صورة تترفع الأول.
- لو الكومباوند بيراجع (الافتراضي) الإعلان بيبدأ `pending_review` ومبيظهرش غير بعد الموافقة؛ لو عدّى حد الإعلانات المفتوحة: `409 MARKET_LISTING_LIMIT_REACHED {max}`.
- `GET /market/listings?q&kind&category&minPrice&maxPrice&sort`: الإعلانات الشغالة بس. البحث بالكلمة لحد ٣٠ مرة في الدقيقة. ترتيب السعر بيسيب الإعلانات اللي من غير سعر.
- الإعلان بيبيّن **العمارة بس**: لا اسم ولا وحدة. `seller.mine` لو هو بتاعك.
- إعلاناتي: `GET /me/market/listings` (كل الحالات، ومعاها `reasonCode`). تعديل وهو مستني أو شغال (لو الكومباوند بيراجع بيرجع للمراجعة)، سحب `…/withdraw`، اتباع `…/sold`. اللي خلص ميتغيرش: `409 MARKET_LISTING_ENDED`.
- إشعارات البيّاع: اتقبل، اترفض `{reason}`، اتشال `{reason}`، وقرّب يخلص (قبلها بيومين، مرة واحدة).

## الساكن — وحدة للبيع أو للإيجار
- `kind: unit_sale | unit_rent` مع `unitId`: لمالك الوحدة بس، ساكن فيها أو لأ؛ غير كده `403 MARKET_UNIT_NOT_OWNED`. إعلان مفتوح واحد للوحدة ولكل نوع: `409 MARKET_UNIT_LISTED`.
- الإعلان بيبيّن النوع والمساحة والعمارة والدور — **عمره ما بيبيّن كود الوحدة**. بيتسحب لوحده لما الملكية تخلص.

## الساكن — الكلام مع البيّاع
- `POST /market/listings/:id/conversations { body }`: محادثة مستخبية زي بتاعة البوست، وبعدها `/neighbour-conversations/:id` عادي (رد، بلاغ، بلوك).
- إعلانك أو إعلان مش شغال: `409 MARKET_LISTING_NO_CONTACT`. البلوك والحد اليومي زي اللوحة.

## الساكن — المحل
- `POST /market/shops { nameEn, nameAr, description, category, fromUnitId? }`: بيبدأ `pending`. محل مفتوح واحد للحساب: `409 MARKET_SHOP_EXISTS`.
- `GET /me/market/shop` (محلي بأي حالة)، `POST /me/market/shop/close` (للأبد). الإعلان ممكن يتنسب لمحلك الشغال (`shopId`).

## الساكن — البلاغ
- `POST /market/listings/:id/report { reasonCode, note? }` من `marketReport`؛ الملاحظة للإدارة بس. مرة واحدة للإعلان، ومش على إعلانك.
- بلاغات من عدد كفاية من البيوت (٣ افتراضي) بتخبّي الإعلان للمراجعة. المبلّغ بيتبلغ إن بلاغه اتشاف، مش النتيجة.

## الإدارة — `/market`
- **المراجعة:** الإعلانات المستنية والمبلَّغ عنها: قبول، رفض بسبب (`marketListingReject`)، شيل بسبب (`marketListingRemove`).
- **البلاغات:** قفل كل بلاغ بنتيجة (`marketReportOutcome`)؛ `removed` بيشيل الإعلان.
- **المحلات:** فتح، رفض، إيقاف بسبب، ورجوع المحل الموقوف.
- **الإعدادات:** المراجعة (شغالة افتراضي)، أقصى إعلانات مفتوحة (١٠)، مدة الإعلان (٣٠ يوم)، عدد البيوت اللي بتخبّي (٣).
- الإدارة بس بتشوف حساب البيّاع وكود وحدته.
