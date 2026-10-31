# الحياة اليومية — Prayer, buses, gallery, busy levels

> **التطبيق/الواجهة:** تطبيق الساكن؛ لوحة المدير `/daily-life`
> **الصلاحيات:** القراءة: `community.read`؛ الإدارة: `content.manage`
> **المصادر:** ADR 0071 · `src/engagement/{prayer,transport,gallery,brief}` · `src/facilities/busy` · `src/gate/gates`

## مواعيد الصلاة
- `GET /prayer-times?on=` (النهارده افتراضي): الفجر والشروق والضهر والعصر والمغرب والعشا، لحظات. قبل ما الإدارة تحدد مكان الكومباوند: `409 PRAYER_PLACE_NOT_SET` — خبّي الكارت.
- الإدارة: `PATCH /community/prayer-settings { latitude, longitude, prayerMethod, asrMadhab }` (الاتنين مع بعض أو ولا واحد؛ المصرية افتراضي).
- بتتحسب على السيرفر من غير إنترنت؛ التطبيق مش محتاج لوكيشن.

## الباصات
- `GET /buses`: الخطوط ومواعيدها في الأسبوع (الأيام، `HH:mm`، من محطة لمحطة) و`next`: الجاي النهارده وبكرة.
- الإدارة: `/community/bus-routes` (إضافة، تعديل، إيقاف)، `…/:id/departures`، `DELETE /community/bus-departures/:id` (الجدول مش سجل: الميعاد اللي بطّل يتمسح).

## الجاليري
- الإدارة بس بترفع (`gallery_photo`، ١٠ ميجا) في ألبومات، لحدث أو لأ؛ الألبوم بيتنشر مرة واحدة.
- الساكن: `GET /gallery/albums`، `…/:id`؛ `POST /gallery/photos/:id/report { reasonCode }` من `galleryPhotoReport`، مرة واحدة. **بلاغ الخصوصية بيخبّي الصورة فورًا** لحد ما الإدارة تقرر.
- الإدارة: بتبلّغ بـ`gallery_photo.reported`؛ `…/photos/:id/hide { reasonCode? }` أو `…/restore`. الصورة المستخبية عمرها ما بتظهر للساكن.

## الزحمة
- دايمًا `quiet` أو `normal` أو `busy` — **عمرها ما بتبقى رقم**، ومفيش إشعار بالزحمة المتوقعة.
- المرفق اللي بيتحجز: كل سلوت فيه `busy`؛ المرفق نفسه `busyNow` و`usuallyBusy` (فاضي لحد ما يبقى فيه ٤ أسابيع تاريخ). المرافق المفتوحة من غير حجز ملهاش.
- البوابة: الدخول في آخر ربع ساعة قصاد حدود الكومباوند (١٠ و٣٠ افتراضي)، في `GET /gates/status` وفي الملخص اليومي. دخول السكان نفسهم مش بيتسجل.

## الملخص اليومي
- `GET /me/daily-brief` زاد: `prayer` (أو null)، `buses` (أقرب ٣)، وزحمة كل بوابة.
