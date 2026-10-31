# عروض الشركاء والشراء الجماعي — Partner and group offers

> **التطبيق/الواجهة:** تطبيق الساكن؛ لوحة المدير `/market/offers`
> **الصلاحيات:** القراءة: `market.post`؛ عروض الشركاء: `partners.manage`؛ الشراء الجماعي: `market.handle`
> **المصادر:** ADR 0071 · `src/partners/offers` · `src/partners/group-offers`

## عروض الشركاء
- الساكن: `GET /market/offers`: العروض الشغالة النهارده بالعربي والإنجليزي، واسم الشريك، و`validFromOn`/`validToOn`. قراية بس، مفيش حاجة تتصرف في التطبيق.
- الإدارة: `POST /staff/partners/:id/offers` (لحد سنة)، `GET /staff/partner-offers`، `…/:id/withdraw` مرة واحدة. شريك موقوف عروضه متظهرش.

## الشراء الجماعي
- الإدارة: `POST /staff/group-offers { titleEn/Ar, bodyEn/Ar, listPrice, groupPrice, minParticipants, maxParticipants?, interestClosesAt?, closesAt, partnerId? }`: سعر الجروب أقل من السعر العادي، بيتين على الأقل. لو فيه مرحلة اهتمام بيبدأ `interest`، وإلا `open` على طول؛ `…/open` بدري، `…/cancel { reasonCode }`.
- الساكن: `GET /market/group-offers`، `…/:id`؛ `…/interest { unitId }` في مرحلة الاهتمام (عدّ بس، مش التزام)؛ `…/join { unitId, quantity }` (١–١٠) وهو مفتوح؛ `…/leave` وهو مفتوح.
- بيبيّن `interested` و`joined` (بيوت) و`mySaving` = (العادي − الجروب) × الكمية.
- لما يقفل: `confirmed` لو البيوت كفاية، وإلا `failed`؛ كل مشترك بيتبلغ. الأخطاء: `409 GROUP_OFFER_PHASE`، `GROUP_OFFER_FULL`، `GROUP_OFFER_JOINED`، `GROUP_OFFER_NOT_JOINED`.
- **مفيش فلوس بتعدّي على جوار**: الدفع للشريك مباشرة. لازم التطبيق يقول كده.
