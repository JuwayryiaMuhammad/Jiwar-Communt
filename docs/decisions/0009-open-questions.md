# 0009 — Open questions

**Status:** Open

1. ~~**Self-registration.**~~ *Closed in Phase 2.2: a request that a manager approves (ADR 0024).* The journey documents describe resident self-registration with manager approval; ADR 0003 drops it for now. Confirm with the product owner that this is agreed.
2. **Compound handover between tenants.** If developers or management companies become customers, a compound may move from one tenant to another (e.g. developer → operator after handover). Needs an explicit, audited transfer design.
3. **A second OTP channel.** Field staff may not read email on shift; WhatsApp or SMS behind `OtpChannel`.
4. **Shorter sessions for sensitive roles** (accountant, system admin, control room re-verify every session in the journey documents). The per-type policy exists; the values and account types do not yet.
5. **Existing data on schema changes.** Phase 1a made `accounts.role_id` mandatory; Phase 0 data was never deployed, so the dev database was reset instead of backfilled. Once real data exists, such changes need backfill migrations.
6. **Audit log follow-ups** (ADR 0014): hash chaining, blocking owner DDL on audit tables, retention and actor anonymization, read-access logging, export.
7. ~~**Residents without an Egyptian national ID.**~~ *Closed in Phase 2.1: passports are supported (ADR 0018).* From Phase 2 every account must carry a valid Egyptian national ID (`core/common/egyptian-national-id.ts`): the birth date drives the adult/minor rules. Foreign owners and tenants (passport holders) cannot be created until an alternative identity document, and a way to know their age, is designed.
8. ~~**Durable notifications.**~~ *Emails closed in Phase 2.1 (outbox, ADR 0019); worker notices will use the same outbox when SMS/WhatsApp exist.* Household and delegation emails are sent after commit, best effort; worker notices are stored but not yet sent. Both want an outbox with retries once SMS/WhatsApp arrive (ADR 0016, 0017).
9. **Screen-dependent details** to confirm with the design:
   - the worker schedule shape (overnight windows are supported since Phase 2.1);
   - whether occupants count toward the household limit (they do not today);
   - which fields of a member or worker each role sees;
   - ~~whether a rejected join request gets the same email as a removal~~ (its own email since Phase 2.1).
10. **The first adult of a unit with no primary.** *Phase 2.2: the manager now resolves a `primary_left` flag with setPrimary or endHousehold (ADR 0021); a self-service path still does not exist.* A unit flagged `primary_left` has no one who can invite until the manager sets a primary; there is no self-service path for that.
11. **Who sees dead outbox messages.** A notice that could not be delivered is kept as evidence (ADR 0019), but nobody is told yet. It belongs with the manager notifications.
12. **Left out of Phase 2.2**, each with its journey source:
    - **Relation correction** ("صحّح الصلة", including adult → minor cancelling financial requests): 05 §7 "صلة قرابة غير صحيحة". The database already refuses making a member with a finance grant a minor (ADR 0021).
    - **Absence notices** ("لم يدخل [الساكن الرئيسي] منذ [المدة]. طلبك بانتظاره"): 05 §7 "غياب الساكن الرئيسي أو وفاته".
    - **"Request independence"** (طلب استقلال, decided by management): 05 §4 "ملفي ونشاطي".
    - **The permission-request inbox** ("اطلب صلاحية إضافية", and "اطلب من الإدارة" during a separation): 05 §4 "صلاحياتي" and 05 §7 "الانفصال داخل الوحدة". Deferred actions (ADR 0021) cover only an action cut short by a revocation.
    - **Multi-tenant units** ("لا تُضاف أفراد أسرة في الوحدات متعددة المستأجرين"): 05 §2. Units have no multi-tenant flag.
    - **Request correction** of a registration document ("اطلب تصحيحاً"): 03 §4 "السكان — الوحدات". Needs document storage.
    - **Member quotas vs unit limits** (visitor and booking quotas distributed between members): 02 §8b "تعارض إعداداته مع بعضها" and 05 §7 "تعارض الإعدادات". Belongs with the gate and bookings.
    - **The retention policy table** (data type, period, delete / anonymize / archive, basis): 09 §5 "الاحتفاظ والخصوصية". Retention of `security_events` (IP, user agent of erased accounts) is part of it.
13. **Self-service "not me"** waits for an SMS/WhatsApp OTP channel (#3): with OTP by email, the new holder of a number never reaches the old account (ADR 0023).
14. **Dead outbox messages and undeliverable notices** (#11) now include `NO_RECIPIENT` records (minors, unheld permissions, erased accounts); still nobody is shown them.

