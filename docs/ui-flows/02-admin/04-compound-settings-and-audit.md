# إعدادات الكمبوند وسجل التدقيق — Compound Settings and Audit Log

> **التطبيق/الواجهة:** manager dashboard
> **الصلاحيات:** `settings.manage` لقراءة الإعدادات وتعديلها، و`audit.read` لقراءة سجل التدقيق. في الأدوار الافتراضية يملكهما دور `manager` فقط.
> **المصادر:** ADR 0014 · ADR 0016 · ADR 0028 · ADR 0030 · `src/core/tenant-settings/` · `src/core/audit/`

## الفكرة باختصار
**الإعدادات:** لكل كمبوند صف إعدادات واحد يُنشأ معه بقيم افتراضية. يتحكم المدير منه في قواعد عامة: هل يحتاج انضمام أفراد الأسرة إلى موافقة، وأقصى عدد لأفراد الأسرة ولتصاريح الزوار، والمنطقة الزمنية، ومهلة رد الأسرة على البوابة، وما يُعرض للزوار.
**سجل التدقيق:** كل إجراء يغيّر شيئًا في الكمبوند يُسجل تلقائيًا: من فعله، وماذا فعل، وعلى ماذا، ومتى، وما الذي تغير. لا يمكن تعديل السجل ولا حذفه، ولا يحتوي على بيانات شخصية بقيمتها.

## الأدوار ومين بيعمل إيه
| الدور | ماذا يستطيع |
|---|---|
| من يملك `settings.manage` (افتراضيًا `manager`) | قراءة الإعدادات العامة وتعديلها |
| من يملك `audit.read` (افتراضيًا `manager`) | قراءة سجل تدقيق الكمبوند وفلترته |
| النظام | يكتب في السجل تلقائيًا مع كل إجراء، وبعض الإجراءات فاعلها `system` (المهام الدورية مثل الإغلاق التلقائي) |
| السوبر أدمن | لا يقرأ سجل الكمبوند. له سجل المنصة الخاص (`./01-super-admin-platform.md`) |

## الشاشات اللي الفيتشر محتاجها
- **شاشة الإعدادات العامة**: نموذج واحد فيه الحقول السبعة (انظر الجدول) مع زر حفظ.
- **سجل التدقيق**: جدول زمني (الأحدث أولًا) مع فلاتر: نوع الإجراء، الفاعل، نوع الهدف، الهدف، والفترة الزمنية.
- **تفاصيل قيد في السجل** (درج أو حوار): الحقول التي تغيرت (من → إلى)، والبيانات الإضافية، ورقم الطلب.
- **روابط من السجل**: إلى صفحة الحساب الفاعل أو الهدف (عبر `GET /accounts/{id}`) عندما يكون الهدف حسابًا.

إعدادات أخرى لها شاشاتها الخاصة في مجالاتها، ولا تخضع لـ`settings.manage`: إعدادات الصيانة (`/maintenance/settings`، `/maintenance/dispatch-settings`، `/maintenance/sla-settings`، بصلاحية `maintenance.manage`)، وإعدادات الطرود (`/parcel-settings`، `parcels.manage`)، وإعدادات طلبات الإدارة وساعات العمل (`/management/request-settings`، `/management/office-hours`، `requests.manage`). يمكن للتصميم أن يجمعها في قسم "الإعدادات" ويظهر كل جزء حسب صلاحيته.

## الفلو خطوة بخطوة

### 1) عرض الإعدادات
1. المدير يفتح "الإعدادات" → `GET /settings`.
2. الرد: كائن فيه الحقول السبعة بقيمها الحالية.

### 2) تعديل الإعدادات
1. المدير يعدّل حقلًا أو أكثر → `PATCH /settings` مع الحقول التي تغيرت فقط.
2. القاعدة: **الحقل غير المرسل يبقى كما هو.** و`null` يمسح الحقلين النصيين الاختياريين فقط (`visitorDirections` و`emergencyPhone`).
3. الفحوص (كل خطأ يرجع `400 VALIDATION_FAILED` مع `fields[]`):
   - `maxHouseholdMembers`: عدد صحيح من 1 إلى 100 (`INVALID_NUMBER` مع `params.min/max`).
   - `maxActiveVisitorPasses`: عدد صحيح من 1 إلى 500.
   - `gateRequestTimeoutSeconds`: عدد صحيح من 30 إلى 1800.
   - `timezone`: اسم منطقة IANA معروف (مثل `Africa/Cairo`) أو `UTC` (`INVALID_VALUE`).
   - `visitorDirections`: من 1 إلى 2000 حرف بعد حذف الفراغات الطرفية (`INVALID_LENGTH`). النص الفارغ مرفوض. لمسحه أرسل `null`.
   - `emergencyPhone`: رقم هاتف صالح، يُخزن بصيغة E.164 (`INVALID_PHONE`).
   - `familyJoinRequiresApproval`: `true` أو `false`.
4. عند النجاح: `200` مع الإعدادات كلها بعد التعديل. اعرض رسالة "تم الحفظ".
5. إذا تغير شيء فعلًا يُسجل `tenant.settings_changed` في السجل. قيم `visitorDirections` و`emergencyPhone` تظهر في السجل `{changed: true}` فقط.
6. **متى يسري التعديل؟** فورًا على كل عملية جديدة تقرأ الإعداد. ولا يؤثر بأثر رجعي (انظر جدول الإعدادات).

### 3) قراءة سجل التدقيق
1. المدير يفتح "سجل النشاط" → `GET /audit?cursor=&limit=` مع فلاتر اختيارية:
   - `action`: كود إجراء من الكتالوج (مثل `unit.created`)، من 1 إلى 100 حرف.
   - `actorId`: معرّف الحساب الفاعل (UUID).
   - `targetType`: نوع الهدف (مثل `account` أو `ticket`)، من 1 إلى 100 حرف.
   - `targetId`: معرّف الهدف (UUID).
   - `from`: بداية الفترة (شاملة)، و`to`: نهايتها (غير شاملة)، بصيغة ISO 8601.
   - `limit`: من 1 إلى 100، والافتراضي 20.
2. الترتيب: الأحدث أولًا (`occurredAt`). استخدم `nextCursor` للصفحة التالية.
3. لا يوجد بحث نصي. والفلتر بالإجراء يطابق الكود حرفيًا (لا يدعم "كل إجراءات الحسابات" `account.*`).
4. لعرض اسم الفاعل أو الهدف: `GET /accounts/{id}` (يحتاج `accounts.read`). الحساب الممسوح يرجع `{id, erased: true}`، فاعرضه "مستخدم محذوف".
5. صفحة "سجل هذا الحساب" أو "سجل هذا البلاغ": `GET /audit?targetId={id}` (ويمكن إضافة `targetType`).

## البيانات اللي بتظهر

### الإعدادات (`SettingsView`)
| الحقل | الافتراضي | الحدود | تأثيره |
|---|---|---|---|
| `familyJoinRequiresApproval` | `false` | `true`/`false` | عند `true`: البالغ الذي يقبل دعوة الانضمام لأسرة يصبح `pending_approval` حتى يوافق المدير (`household.approve`). عند `false` يصبح `active` فورًا. يُطبق على الدعوات التي تُقبل بعد التغيير |
| `maxHouseholdMembers` | `10` | 1–100 | أقصى عدد (أفراد الأسرة + الدعوات المعلقة) في الوحدة. تجاوزه عند إضافة فرد أو دعوة يرجع `409 HOUSEHOLD_LIMIT_REACHED`. تقليله لا يحذف أحدًا |
| `timezone` | `Africa/Cairo` | منطقة IANA | تُقرأ به مواعيد عمل العمالة المنزلية عند البوابة، والحضور، وطلبات الموافقة، وحساب "اليوم" لبلوغ القاصر سن الرشد |
| `maxActiveVisitorPasses` | `50` | 1–500 | أقصى عدد تصاريح زوار سارية للوحدة الواحدة. تجاوزه يرجع `409 VISITOR_PASS_LIMIT_REACHED`. تقليله لا يلغي التصاريح الحالية |
| `gateRequestTimeoutSeconds` | `180` (3 دقائق) | 30–1800 | المهلة التي تملكها الأسرة للرد على طلب الحارس عند البوابة، وبعدها تُطبق التعليمات الدائمة للوحدة. تُقرأ عند إنشاء الطلب، فلا تتأثر الطلبات المفتوحة |
| `visitorDirections` | `null` | 1–2000 حرف، أو `null` | نص حر يظهر للزائر في صفحة التصريح العامة (إرشادات الوصول) |
| `emergencyPhone` | `null` | هاتف E.164، أو `null` | يظهر للزائر في صفحة التصريح، وعلى بطاقة العامل المنزلي (`securityPhone`) |

### قيد سجل التدقيق (`AuditEntryView`)
| الحقل | المعنى |
|---|---|
| `id` | معرّف القيد |
| `occurredAt` | وقت الإجراء |
| `actorType` | `account` (حساب في الكمبوند)، أو `platform_admin` (السوبر أدمن، مثل إنشاء مدير أو تغيير حالته)، أو `system` (مهمة تلقائية) |
| `actorId` | معرّف الحساب أو الأدمن، و`null` عندما يكون `system` |
| `action` | كود الإجراء (الكتالوج أدناه) |
| `targetType` / `targetId` | نوع الهدف ومعرّفه |
| `changes` | ما تغير: `{ "field": { "from": ..., "to": ... } }`. الحقل الشخصي يظهر `{ "changed": true }` فقط. في الإنشاء تكون `from` = `null` |
| `metadata` | أكواد وأعداد ومعرّفات فقط، مثل `reasonCode`، `sessionsRevoked`، `requestNumber`، `roleKey`. لا بيانات شخصية أبدًا |
| `requestId` | رقم الطلب، يفيد الدعم الفني |

**لا يظهر للمدير IP ولا user agent** (يظهران للسوبر أدمن في سجل المنصة فقط).

### قواعد البيانات الشخصية في السجل
- السجل لا يُحذف أبدًا، لذلك لا يحتوي أي بيانات قد يطلب صاحبها مسحها.
- هذه الحقول تُسجل دائمًا `{changed: true}` بدل قيمتها: `fullName`، `firstName`، `lastName`، `nationalId`، `idDocumentNumber`، `nationality`، `phone`، `email`، `birthDate`، `accessCode`، وأي حقل يحتوي اسمه على `password` أو `hash` أو `token` أو `secret` (ما عدا `mustChangePassword`).
- وبعض الإجراءات تخفي حقولًا إضافية: `photo` (صورة الحساب أو العامل)، `visitorDirections` و`emergencyPhone` (الإعدادات)، `nameAr` و`nameEn` (أسماء الخدمات الوقائية وموضوعات الطلبات).
- أي قيمة تبدو بريدًا أو هاتفًا مصريًا أو رقمًا قوميًا (14 رقمًا) تُستبدل بالنص `"[redacted]"`. قد يحدث ذلك لقيمة عادية (مثل كود وحدة يشبه رقم هاتف). اعرض `[redacted]` كـ"قيمة مخفية".
- لا تُسجل في السجل أبدًا: نصوص الرسائل، والملاحظات، ووصف البلاغات، وأسماء الزوار، والأكواد، وأسماء الملفات.
- الحساب الممسوح يبقى معرّفه في السجل، ويظهر "مستخدم محذوف". التاريخ لا يُمس.

### كتالوج الإجراءات (ملخص حسب المجال)
| المجال | `targetType` | الإجراءات |
|---|---|---|
| الحسابات | `account` | `account.created`، `account.status_changed`، `account.locale_changed`، `account.photo_changed`، `account.contact_changed`، `account.frozen`، `account.reactivated` |
| حذف الحسابات | `account` | `account.deletion_requested`، `account.deletion_cancelled`، `account.deletion_queued`، `account.deletion_closed`، `account.legal_hold_placed`، `account.legal_hold_released`، `account.erased` |
| التفضيلات والموافقات | `account` | `notification_preferences.changed`، `consent.granted`، `consent.revoked` (و`metadata.assisted` إذا تصرف المدير نيابة عن الساكن) |
| تصدير البيانات | `data_export` | `data_export.requested`، `.ready`، `.downloaded`، `.expired`، `.failed` |
| الأدوار | `role` | `role.permissions_replaced` (تعديل المدير)، `role.permissions_synced` (مزامنة النشر) |
| الإعدادات | `tenant` | `tenant.settings_changed`، `maintenance.settings_changed`، `maintenance.dispatch_settings_changed`، `maintenance.sla_settings_changed`، `parcel.settings_changed`، `management.settings_changed`، `management.office_hours_changed` |
| التسجيل الذاتي | `tenant` / `resident_registration` | `registration_link.created`، `registration_link.revoked`، `resident.self_registered`، `resident.registration_approved`، `resident.registration_rejected`، `resident.registration_expired` |
| الوحدات | `unit` | `unit.created`، `unit.closed_mode_changed`، `unit.details_submitted`، `unit.household_review_flagged`، `unit.household_review_cleared`، `unit.household_ended`، `unit.ownership_transferred`، `household.permissions_reviewed`، `gate.instructions_changed` |
| الإشغال (السكن) | `occupancy` | `occupancy.created`، `occupancy.ended`، `occupancy.primary_changed`، `occupancy.converted`، `occupancy.residence_changed`، `occupancy.handed_over` |
| الأسرة | `household_invite` / `household_member` / `household_delegation` / `household_deferred_action` | `household.invite_created/revoked/accepted`، `household.member_added/approved/rejected/removed`، `household.member_majority_reached`، `household.member_came_of_age`، `household.permission_granted/revoked`، `household.delegation_created/revoked/ended`، `household.deferred_action_submitted/decided` |
| العمالة المنزلية | `worker_engagement` / `domestic_worker` | `worker.registered`، `worker.engagement_reviewed/suspended/resumed/ended`، `worker.code_reissued`، `worker.wage_changed`، `worker.wage_obligation_recorded/settled`، `worker.card_incident_reported/closed`، `worker.photo_changed`، `worker.banned/unbanned`، `worker.birth_date_attested/corrected`، `worker.compliance_case_opened/closed` |
| البوابة | `gate` / `guard_shift` / `visitor_pass` / `entry_credential` / `gate_approval_request` | `gate.created/updated`، `gate.shift_started/ended`، `visitor_pass.created/cancelled/code_reissued`، `entry_credential.issued/revoked`، `gate.approval_requested/decided/reversed/withdrawn` |
| الملفات | `file` | `file.created`، `file.deleted` (الغرض والنوع والحجم فقط) |
| الصيانة | `ticket_category` / `ticket` / `preventive_service` / `specialty` / `account` | `ticket_category.created/updated/specialties_changed/sla_targets_changed`، `ticket.created_on_behalf`، `ticket.priority_changed`، `ticket.category_changed`، `ticket.cancelled`، `ticket.escalated_by_resident`، `preventive_service.created/updated`، `specialty.created/updated`، `technician.specialties_changed` |
| الطرود | `parcel` | `parcel.received/handed_over/rejected/returned`، `parcel.delegate_authorized/revoked` |
| طلبات الإدارة | `management_request_topic` / `management_request` / `management_appointment` | `management_request_topic.created/updated`، `management_request.created/created_on_behalf/assigned/unassigned/started/answered/resumed/escalated/closed/withdrawn/auto_closed/reopened/rated`، `management_appointment.requested/proposed/confirmed/cancelled` |

ما **لا يُسجل** في هذا السجل: القراءات (فتح شاشة أو عرض بيانات)، وتغيّر حالة البلاغ نفسه وإسناده (لها تاريخها داخل البلاغ)، وزيارات الفنيين، ومسح الساكن لكود الـQR عند البوابة، ونصوص الرسائل. إجراءات المنصة (`tenant.created`، `tenant.status_changed`…) في سجل المنصة وحده.

## القواعد والقيود
- صف إعدادات واحد لكل كمبوند، يُنشأ مع الكمبوند. لا يوجد "استعادة القيم الافتراضية".
- `PATCH /settings` جزئي: ما لا يُرسل لا يتغير.
- التعديل يسري فورًا على العمليات الجديدة، وبلا أثر رجعي على ما هو موجود.
- آخر حفظ هو الذي يبقى. لا يوجد فحص تعارض إذا عدّل مديران في الوقت نفسه.
- السجل يُكتب في نفس transaction الإجراء: لا إجراء بلا قيد، ولا قيد لإجراء فشل.
- السجل للقراءة فقط: لا تعديل ولا حذف ولا تصدير.
- `from` شامل و`to` غير شامل. لعرض "يوم 5" أرسل `from=…-05T00:00` و`to=…-06T00:00` (مع مراعاة المنطقة الزمنية).
- القوائم cursor-paged (انظر `../README.md`).

## الأخطاء اللي الـUI لازم يتعامل معاها
| HTTP + code | متى | رسالة أو سلوك مقترح |
|---|---|---|
| `400 VALIDATION_FAILED` (`INVALID_NUMBER`) | رقم خارج الحدود في الإعدادات (`params.min`، `params.max`) | "القيمة يجب أن تكون بين {min} و{max}." |
| `400 VALIDATION_FAILED` (`INVALID_VALUE` على `timezone`) | منطقة زمنية غير معروفة | "اختر منطقة زمنية من القائمة." |
| `400 VALIDATION_FAILED` (`INVALID_LENGTH` على `visitorDirections`) | نص فارغ أو أطول من 2000 حرف | "النص يجب أن يكون بين 1 و2000 حرف. لمسحه استخدم زر الحذف." |
| `400 VALIDATION_FAILED` (`INVALID_PHONE` على `emergencyPhone`) | رقم غير صالح | "رقم الهاتف غير صحيح." |
| `400 VALIDATION_FAILED` | فلتر غير صالح في السجل (UUID غير صحيح، أو تاريخ ليس ISO، أو `limit` خارج 1–100) | خطأ في الواجهة. صحّح الفلتر |
| `403 FORBIDDEN` | لا يملك `settings.manage` أو `audit.read` | أخفِ الشاشة |

## الـEndpoints
| Method + path | من يستدعيه | الغرض | الرد |
|---|---|---|---|
| `GET /settings` | `settings.manage` | قراءة الإعدادات العامة | `200` `SettingsView` |
| `PATCH /settings` | `settings.manage` | تعديل جزئي للإعدادات | `200` `SettingsView` |
| `GET /audit` | `audit.read` | سجل تدقيق الكمبوند مع الفلاتر | `200` `{data: AuditEntryView[], nextCursor}` |
| `GET /accounts/{id}` | `accounts.read` | تحويل `actorId`/`targetId` إلى اسم | `200` (انظر `./03-staff-accounts.md`) |

## ملاحظات للديزاين وحاجات ناقصة في الباك
- السجل يعرض معرّفات فقط (`actorId`، `targetId`)، كما يذكر `docs/api/v0-notes.md`. لا يوجد endpoint يرجع الأسماء دفعة واحدة. عرض صفحة من 20 قيدًا قد يحتاج 20 طلبًا لـ`GET /accounts/{id}`. والأهداف غير الحسابات (بلاغ، وحدة، طرد) تحتاج endpoint مجالها.
- `actorType = platform_admin` لا يمكن تحويله إلى اسم من داخل الكمبوند. اعرضه "إدارة المنصة".
- لا يوجد endpoint يرجع كتالوج الإجراءات أو أنواع الأهداف لملء الفلاتر. تضعها الواجهة ثابتة (الجدول أعلاه)، مع ترجمة عربية لكل كود.
- لا فلتر بمجموعة إجراءات أو بالمجال، ولا بحث، ولا تصدير (ADR 0014 يذكر التصدير بندًا مفتوحًا).
- ADR 0014 يذكر تسجيل القراءات للبيانات الحساسة، وسلاسل hash لكشف التلاعب، وسياسة الاحتفاظ. **كلها غير منفذة.**
- `SettingsView` لا يحتوي اسم الكمبوند، ولا يوجد endpoint لتعديله من جهة المدير.
- الإعدادات بلا `updatedAt` ولا "من عدّل آخر مرة". أقرب بديل: `GET /audit?action=tenant.settings_changed`.
- صياغة نص `changes` للمستخدم (مثل "غيّر الحد الأقصى من 10 إلى 12") مسؤولية الواجهة، حسب كود الإجراء وأسماء الحقول.
