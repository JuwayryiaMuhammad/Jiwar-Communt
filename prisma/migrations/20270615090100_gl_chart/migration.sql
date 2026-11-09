-- ============================================================================
-- The standard chart of accounts (ADR 0092), seeded for every compound by
-- `gl_seed_chart`: at its creation (finance's provisioning), here for the
-- compounds that exist (20270615090300), and by the posting functions for a
-- compound that has none yet. Idempotent: an account already there is kept
-- as the accountant named it. A treasury account (ADR 0085) gets its own
-- account under its heading when it is opened.
-- ============================================================================

-- The system accounts: code, key, parent's key, type, names, control (its
-- register keeps it: no manual line, no sub-account), postable (a heading
-- takes no line).
CREATE FUNCTION "gl_chart_rows"() RETURNS TABLE (
  ord int, code text, key text, parent_key text, type text,
  name_en text, name_ar text, control boolean, postable boolean)
  LANGUAGE sql IMMUTABLE AS $$
  VALUES
    (10, '1000', 'assets', NULL, 'asset', 'Assets', 'الأصول', false, false),
    (11, '1100', 'cash_and_banks', 'assets', 'asset', 'Cash and banks', 'النقدية والبنوك', false, false),
    (12, '1110', 'bank_accounts', 'cash_and_banks', 'asset', 'Bank accounts', 'الحسابات البنكية', false, false),
    (13, '1120', 'cash_boxes', 'cash_and_banks', 'asset', 'Cash boxes', 'الخزائن النقدية', false, false),
    (14, '1200', 'in_transit', 'assets', 'asset', 'Money in transit', 'أموال في الطريق', false, false),
    (15, '1210', 'undeposited_cash', 'in_transit', 'asset', 'Office cash not yet in a cash box', 'نقدية المكتب قبل الخزينة', false, true),
    (16, '1220', 'cheques_in_hand', 'in_transit', 'asset', 'Cheques received, not yet cleared', 'شيكات تحت التحصيل', false, true),
    (17, '1230', 'transfers_in_transit', 'in_transit', 'asset', 'Bank transfers not yet matched', 'تحويلات بنكية قبل المطابقة', false, true),
    (18, '1240', 'gateway_receivable', 'in_transit', 'asset', 'Online payments not yet settled', 'مدفوعات إلكترونية قبل التسوية', false, true),
    (19, '1250', 'internal_transfers', 'in_transit', 'asset', 'Transfers between accounts', 'تحويلات بين الحسابات', false, true),
    (20, '1300', 'receivables', 'assets', 'asset', 'Receivables from units', 'مستحقات على الوحدات', true, true),
    (21, '1400', 'vendor_advances', 'assets', 'asset', 'Advances to vendors', 'دفعات مقدمة للموردين', true, true),
    (22, '1900', 'suspense', 'assets', 'asset', 'Suspense', 'حساب معلّق', false, true),
    (30, '2000', 'liabilities', NULL, 'liability', 'Liabilities', 'الالتزامات', false, false),
    (31, '2100', 'unit_credit', 'liabilities', 'liability', 'Unit credit and advances', 'أرصدة دائنة ومقدمات الوحدات', true, true),
    (32, '2200', 'deposits_held', 'liabilities', 'liability', 'Deposits held', 'تأمينات محتجزة', true, true),
    (33, '2300', 'payables', 'liabilities', 'liability', 'Payables to vendors', 'مستحقات الموردين', true, true),
    (34, '2400', 'retentions', 'liabilities', 'liability', 'Retentions held', 'محتجزات ضمان الأعمال', true, true),
    (35, '2500', 'refunds_in_transit', 'liabilities', 'liability', 'Refunds paid, not yet matched', 'مبالغ مستردة قبل المطابقة', false, true),
    (36, '2600', 'unregistered_payments', 'liabilities', 'liability', 'Expenses paid outside the treasury', 'مصروفات دُفعت خارج الخزينة', false, true),
    (40, '3000', 'equity', NULL, 'equity', 'Equity', 'حقوق الملكية', false, false),
    (41, '3100', 'opening_balances', 'equity', 'equity', 'Opening balances', 'الأرصدة الافتتاحية', false, true),
    (42, '3200', 'accumulated_surplus', 'equity', 'equity', 'Accumulated surplus', 'الفائض المتراكم', false, true),
    (50, '4000', 'revenue', NULL, 'revenue', 'Revenue', 'الإيرادات', false, false),
    (51, '4100', 'revenue:service_charge', 'revenue', 'revenue', 'Service charges', 'رسوم الخدمات', false, true),
    (52, '4110', 'revenue:maintenance', 'revenue', 'revenue', 'Maintenance fees', 'رسوم الصيانة', false, true),
    (53, '4120', 'revenue:facility', 'revenue', 'revenue', 'Facility bookings', 'حجوزات المرافق', false, true),
    (54, '4130', 'revenue:club', 'revenue', 'revenue', 'Club memberships', 'اشتراكات النادي', false, true),
    (55, '4140', 'revenue:fine', 'revenue', 'revenue', 'Vehicle fines', 'مخالفات المركبات', false, true),
    (56, '4150', 'revenue:violation', 'revenue', 'revenue', 'Violation fines', 'غرامات المخالفات', false, true),
    (57, '4160', 'revenue:damage', 'revenue', 'revenue', 'Damage claims', 'مطالبات التلفيات', false, true),
    (58, '4190', 'revenue:other', 'revenue', 'revenue', 'Other charges', 'رسوم أخرى', false, true),
    (59, '4200', 'income:interest', 'revenue', 'revenue', 'Interest income', 'إيراد الفوائد', false, true),
    (60, '4300', 'income:deposits_retained', 'revenue', 'revenue', 'Deposits deducted and forfeited', 'خصومات ومصادرات التأمينات', false, true),
    (70, '5000', 'expenses', NULL, 'expense', 'Expenses', 'المصروفات', false, false),
    (71, '5100', 'expense:security', 'expenses', 'expense', 'Security', 'الأمن', false, true),
    (72, '5110', 'expense:cleaning', 'expenses', 'expense', 'Cleaning', 'النظافة', false, true),
    (73, '5120', 'expense:landscaping', 'expenses', 'expense', 'Landscaping', 'تنسيق الحدائق', false, true),
    (74, '5130', 'expense:maintenance', 'expenses', 'expense', 'Maintenance', 'الصيانة', false, true),
    (75, '5140', 'expense:utilities', 'expenses', 'expense', 'Utilities', 'المرافق', false, true),
    (76, '5150', 'expense:staff', 'expenses', 'expense', 'Staff', 'العاملون', false, true),
    (77, '5160', 'expense:insurance', 'expenses', 'expense', 'Insurance', 'التأمين', false, true),
    (78, '5170', 'expense:administration', 'expenses', 'expense', 'Administration', 'الإدارة', false, true),
    (79, '5180', 'expense:reserve_fund', 'expenses', 'expense', 'Reserve fund', 'الاحتياطي', false, true),
    (80, '5190', 'expense:other', 'expenses', 'expense', 'Other expenses', 'مصروفات أخرى', false, true),
    (81, '5200', 'expense:bank_charges', 'expenses', 'expense', 'Bank charges', 'مصروفات بنكية', false, true),
    (82, '5300', 'expense:cash_over_short', 'expenses', 'expense', 'Cash over and short', 'عجز وزيادة النقدية', false, true)
$$;

-- A treasury account's own account, under the bank or cash heading, its
-- code the next under it (the heading locked, so two at once take two).
CREATE FUNCTION "gl_open_cash_account"(t uuid, cash uuid, kind text, name text) RETURNS uuid
  LANGUAGE plpgsql AS $$
DECLARE
  head record;
  found uuid;
  n int;
BEGIN
  SELECT a."id" INTO found FROM "gl_accounts" a
   WHERE a."tenant_id" = t AND a."cash_account_id" = cash;
  IF found IS NOT NULL THEN RETURN found; END IF;
  SELECT a."id", a."code" INTO head FROM "gl_accounts" a
   WHERE a."tenant_id" = t
     AND a."system_key" = CASE WHEN kind = 'bank' THEN 'bank_accounts' ELSE 'cash_boxes' END
   FOR UPDATE;
  IF head."id" IS NULL THEN
    RAISE EXCEPTION 'compound %: no chart of accounts', t USING ERRCODE = 'no_data_found';
  END IF;
  SELECT count(*) + 1 INTO n FROM "gl_accounts" a
   WHERE a."tenant_id" = t AND a."parent_id" = head."id";
  found := gen_random_uuid();
  INSERT INTO "gl_accounts" ("id", "tenant_id", "code", "name_en", "name_ar", "type",
                             "parent_id", "system_key", "cash_account_id", "control", "postable")
  VALUES (found, t, head."code" || '.' || lpad(n::text, 2, '0'), name, name, 'asset',
          head."id", 'cash:' || cash::text, cash, true, true);
  RETURN found;
END $$;

CREATE FUNCTION "gl_seed_chart"(t uuid) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM "gl_chart_rows"() ORDER BY ord LOOP
    INSERT INTO "gl_accounts" ("id", "tenant_id", "code", "name_en", "name_ar", "type",
                               "parent_id", "system_key", "control", "postable")
    VALUES (gen_random_uuid(), t, r.code, r.name_en, r.name_ar, r.type,
            (SELECT a."id" FROM "gl_accounts" a
              WHERE a."tenant_id" = t AND a."system_key" = r.parent_key),
            r.key, r.control, r.postable)
    ON CONFLICT ("tenant_id", "system_key") WHERE "system_key" IS NOT NULL DO NOTHING;
  END LOOP;
  FOR r IN SELECT c."id", c."kind", c."name" FROM "finance_cash_accounts" c
            WHERE c."tenant_id" = t ORDER BY c."created_at", c."id" LOOP
    PERFORM "gl_open_cash_account"(t, r."id", r."kind", r."name");
  END LOOP;
END $$;

-- A system account by its key; the chart seeded first when the compound
-- has none yet.
CREATE FUNCTION "gl_account"(t uuid, key text) RETURNS uuid
  LANGUAGE plpgsql AS $$
DECLARE
  found uuid;
BEGIN
  SELECT a."id" INTO found FROM "gl_accounts" a WHERE a."tenant_id" = t AND a."system_key" = key;
  IF found IS NULL THEN
    PERFORM "gl_seed_chart"(t);
    SELECT a."id" INTO found FROM "gl_accounts" a WHERE a."tenant_id" = t AND a."system_key" = key;
  END IF;
  IF found IS NULL THEN
    RAISE EXCEPTION 'compound %: no system account %', t, key USING ERRCODE = 'no_data_found';
  END IF;
  RETURN found;
END $$;

-- A treasury account's own account.
CREATE FUNCTION "gl_cash_account"(t uuid, cash uuid) RETURNS uuid
  LANGUAGE plpgsql AS $$
DECLARE
  found uuid;
BEGIN
  SELECT a."id" INTO found FROM "gl_accounts" a WHERE a."tenant_id" = t AND a."cash_account_id" = cash;
  IF found IS NULL THEN
    PERFORM "gl_seed_chart"(t);
    SELECT a."id" INTO found FROM "gl_accounts" a WHERE a."tenant_id" = t AND a."cash_account_id" = cash;
  END IF;
  RETURN found;
END $$;

-- A bank or cash account opened in the treasury opens its own account here.
CREATE FUNCTION "finance_cash_accounts_gl"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "gl_account"(NEW."tenant_id", 'bank_accounts');
  PERFORM "gl_open_cash_account"(NEW."tenant_id", NEW."id", NEW."kind", NEW."name");
  RETURN NULL;
END $$;
CREATE TRIGGER "finance_cash_accounts_gl" AFTER INSERT ON "finance_cash_accounts"
  FOR EACH ROW EXECUTE FUNCTION "finance_cash_accounts_gl"();
