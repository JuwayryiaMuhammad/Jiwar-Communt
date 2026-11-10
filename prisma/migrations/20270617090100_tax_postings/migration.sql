-- ============================================================================
-- What taxes and the year-end close post (ADR 0093), by the rules of ADR
-- 0092's postings (20270615090200), whatever path wrote the row.
--
-- - The chart gains three system accounts, control accounts (their
--   registers keep them): 1500 VAT recoverable (input VAT), 2700 VAT
--   payable (output VAT) and 2800 withholding tax payable. Every compound
--   gets them now; a new one with its chart. 3200 accumulated surplus is
--   ADR 0092's.
-- - An invoice credits its kind's revenue with its net and VAT payable with
--   its VAT; a credit note takes back its share of both.
-- - A vendor's invoice approved debits its category with what is not
--   recovered and VAT recoverable with what is (its `vat_recoverable`).
-- - A payout credits withholding payable with what it withheld.
-- - A month's VAT declared sets its input off against its output (VAT
--   payable less what is recovered and carried in, up to the declaration's
--   due); a tax paid debits VAT or withholding payable against its account.
-- - A fiscal year's closing entry, dated its last day, zeroes each revenue
--   and expense account into 3200; a reopening reverses it on that day.
-- The backfill function (20270615090300) is recreated by the same rules.
-- ============================================================================

CREATE OR REPLACE FUNCTION "gl_chart_rows"() RETURNS TABLE (
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
    (23, '1500', 'vat_receivable', 'assets', 'asset', 'VAT recoverable (input VAT)', 'ضريبة القيمة المضافة على المشتريات', true, true),
    (22, '1900', 'suspense', 'assets', 'asset', 'Suspense', 'حساب معلّق', false, true),
    (30, '2000', 'liabilities', NULL, 'liability', 'Liabilities', 'الالتزامات', false, false),
    (31, '2100', 'unit_credit', 'liabilities', 'liability', 'Unit credit and advances', 'أرصدة دائنة ومقدمات الوحدات', true, true),
    (32, '2200', 'deposits_held', 'liabilities', 'liability', 'Deposits held', 'تأمينات محتجزة', true, true),
    (33, '2300', 'payables', 'liabilities', 'liability', 'Payables to vendors', 'مستحقات الموردين', true, true),
    (34, '2400', 'retentions', 'liabilities', 'liability', 'Retentions held', 'محتجزات ضمان الأعمال', true, true),
    (35, '2500', 'refunds_in_transit', 'liabilities', 'liability', 'Refunds paid, not yet matched', 'مبالغ مستردة قبل المطابقة', false, true),
    (36, '2600', 'unregistered_payments', 'liabilities', 'liability', 'Expenses paid outside the treasury', 'مصروفات دُفعت خارج الخزينة', false, true),
    (37, '2700', 'vat_payable', 'liabilities', 'liability', 'VAT payable (output VAT)', 'ضريبة القيمة المضافة المستحقة', true, true),
    (38, '2800', 'withholding_payable', 'liabilities', 'liability', 'Withholding tax payable', 'ضريبة الخصم والتحصيل المستحقة', true, true),
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

-- Every compound with a chart gets the three accounts now (the seed is
-- idempotent: what is there keeps the accountant's names).
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT DISTINCT a."tenant_id" FROM "gl_accounts" a ORDER BY 1 LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM "gl_seed_chart"(t);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- ----------------------------------------------------------------------------
-- A unit's money: the VAT apart.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "gl_post_invoice"(i "invoices") RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  e uuid;
BEGIN
  IF i."total" = 0 THEN RETURN; END IF;
  e := "gl_begin"(i."tenant_id", 'invoice', i."id", i."issued_on", "gl_ref"('INV', i."number"));
  PERFORM "gl_line"(i."tenant_id", e, "gl_account"(i."tenant_id", 'receivables'), i."total", i."unit_id");
  PERFORM "gl_line"(i."tenant_id", e, "gl_account"(i."tenant_id", 'revenue:' || i."kind"::text),
                    -(i."total" - i."vat"));
  PERFORM "gl_line"(i."tenant_id", e, "gl_account"(i."tenant_id", 'vat_payable'), -i."vat");
END $$;

CREATE OR REPLACE FUNCTION "gl_post_credit_note"(c "credit_notes") RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  i record;
  e uuid;
BEGIN
  IF c."amount" = 0 THEN RETURN; END IF;
  SELECT x."kind", x."unit_id" INTO i FROM "invoices" x
   WHERE x."tenant_id" = c."tenant_id" AND x."id" = c."invoice_id";
  e := "gl_begin"(c."tenant_id", 'credit_note', c."id", "gl_local_day"(c."tenant_id", c."created_at"),
                  "gl_ref"('CN', c."number"));
  PERFORM "gl_line"(c."tenant_id", e, "gl_account"(c."tenant_id", 'revenue:' || i."kind"::text),
                    c."amount" - c."vat");
  PERFORM "gl_line"(c."tenant_id", e, "gl_account"(c."tenant_id", 'vat_payable'), c."vat");
  PERFORM "gl_line"(c."tenant_id", e, "gl_account"(c."tenant_id", 'receivables'), -c."amount", i."unit_id");
END $$;

-- ----------------------------------------------------------------------------
-- What the compound spends: the VAT it recovers, the tax it withholds.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "gl_post_vendor_invoice"(v "finance_vendor_invoices") RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  e uuid;
BEGIN
  IF v."total" = 0 THEN RETURN; END IF;
  e := "gl_begin"(v."tenant_id", 'vendor_invoice', v."id", "gl_local_day"(v."tenant_id", v."decided_at"),
                  "gl_ref"('VI', v."number"));
  PERFORM "gl_line"(v."tenant_id", e, "gl_account"(v."tenant_id", "gl_expense_key"(v."tenant_id", v."budget_line_id")),
                    v."total" - v."vat_recoverable", NULL, v."vendor_id");
  PERFORM "gl_line"(v."tenant_id", e, "gl_account"(v."tenant_id", 'vat_receivable'), v."vat_recoverable",
                    NULL, v."vendor_id");
  PERFORM "gl_line"(v."tenant_id", e, "gl_account"(v."tenant_id", 'payables'), -v."total", NULL, v."vendor_id");
END $$;

CREATE OR REPLACE FUNCTION "gl_post_vendor_payout"(p "finance_vendor_payouts") RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  e uuid;
BEGIN
  IF p."gross" = 0 THEN RETURN; END IF;
  e := "gl_begin"(p."tenant_id", 'vendor_payout', p."id", p."paid_on", "gl_ref"('VP', p."number"));
  PERFORM "gl_line"(p."tenant_id", e,
                    "gl_account"(p."tenant_id", CASE p."kind" WHEN 'advance' THEN 'vendor_advances'
                                                              WHEN 'retention_release' THEN 'retentions'
                                                              ELSE 'payables' END),
                    p."gross", NULL, p."vendor_id");
  PERFORM "gl_line"(p."tenant_id", e, "gl_account"(p."tenant_id", 'retentions'), -p."retention_held",
                    NULL, p."vendor_id");
  PERFORM "gl_line"(p."tenant_id", e, "gl_account"(p."tenant_id", 'vendor_advances'), -p."advance_set_off",
                    NULL, p."vendor_id");
  PERFORM "gl_line"(p."tenant_id", e, "gl_account"(p."tenant_id", 'withholding_payable'), -p."withholding",
                    NULL, p."vendor_id");
  IF p."net" > 0 THEN
    PERFORM "gl_line"(p."tenant_id", e, "gl_cash_account"(p."tenant_id", p."cash_account_id"), -p."net",
                      NULL, p."vendor_id");
  END IF;
END $$;

-- A tax payment's movement posts nothing of its own (its payment's entry
-- holds it), as a payout's does not.
CREATE OR REPLACE FUNCTION "gl_post_cash_movement"(m "finance_cash_movements") RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  e uuid;
  other text;
BEGIN
  IF m."kind" IN ('payout', 'tax_payment') THEN RETURN; END IF;
  IF m."kind" = 'reversal' THEN
    IF NOT "gl_posted"(m."tenant_id", 'cash_movement', m."reverses_id") THEN RETURN; END IF;
    e := "gl_begin"(m."tenant_id", 'cash_movement', m."id", m."on_day", NULL);
    PERFORM "gl_mirror"(m."tenant_id", e, 'cash_movement', m."reverses_id");
    RETURN;
  END IF;
  other := CASE m."kind"
    WHEN 'opening' THEN 'opening_balances'
    WHEN 'handin' THEN 'undeposited_cash'
    WHEN 'recovery' THEN 'expense:cash_over_short'
    WHEN 'transfer' THEN 'internal_transfers'
    WHEN 'cheque' THEN 'cheques_in_hand'
    WHEN 'statement_payment' THEN 'transfers_in_transit'
    ELSE CASE m."reason_code"
      WHEN 'bank_charge' THEN 'expense:bank_charges'
      WHEN 'interest' THEN 'income:interest'
      WHEN 'refund_paid' THEN 'refunds_in_transit'
      WHEN 'counting_correction' THEN 'expense:cash_over_short'
      ELSE 'suspense' END
    END;
  e := "gl_begin"(m."tenant_id", 'cash_movement', m."id", m."on_day",
                  (SELECT "gl_ref"('HI', h."number") FROM "finance_custody_handins" h
                    WHERE h."tenant_id" = m."tenant_id" AND h."id" = m."handin_id"));
  PERFORM "gl_line"(m."tenant_id", e, "gl_cash_account"(m."tenant_id", m."account_id"), m."amount");
  PERFORM "gl_line"(m."tenant_id", e, "gl_account"(m."tenant_id", other), -m."amount");
END $$;

-- ----------------------------------------------------------------------------
-- Taxes declared and paid.
-- ----------------------------------------------------------------------------
-- What a declaration sets off: the month's output less what stays due.
CREATE FUNCTION "gl_vat_offset"(d "finance_vat_declarations") RETURNS numeric
  LANGUAGE sql IMMUTABLE AS $$
  SELECT d."output_vat" - d."net_due"
$$;

CREATE FUNCTION "gl_post_vat_declaration"(d "finance_vat_declarations") RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  e uuid;
  x numeric := "gl_vat_offset"(d);
BEGIN
  IF x = 0 THEN RETURN; END IF;
  e := "gl_begin"(d."tenant_id", 'vat_declaration', d."id", "gl_local_day"(d."tenant_id", d."declared_at"),
                  'VAT-' || to_char(d."month", 'YYYY-MM'));
  PERFORM "gl_line"(d."tenant_id", e, "gl_account"(d."tenant_id", 'vat_payable'), x);
  PERFORM "gl_line"(d."tenant_id", e, "gl_account"(d."tenant_id", 'vat_receivable'), -x);
END $$;

CREATE FUNCTION "gl_post_tax_payment"(p "finance_tax_payments") RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  e uuid;
BEGIN
  e := "gl_begin"(p."tenant_id", 'tax_payment', p."id", p."paid_on", "gl_ref"('TXP', p."number"));
  PERFORM "gl_line"(p."tenant_id", e,
                    "gl_account"(p."tenant_id", CASE p."kind" WHEN 'vat' THEN 'vat_payable'
                                                              ELSE 'withholding_payable' END),
                    p."amount");
  PERFORM "gl_line"(p."tenant_id", e, "gl_cash_account"(p."tenant_id", p."cash_account_id"), -p."amount");
END $$;

CREATE FUNCTION "finance_tax_gl"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'finance_vat_declarations' THEN
    PERFORM "gl_post_vat_declaration"(NEW);
  ELSIF TG_TABLE_NAME = 'finance_tax_payments' THEN
    PERFORM "gl_post_tax_payment"(NEW);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER "finance_vat_declarations_gl" AFTER INSERT ON "finance_vat_declarations"
  FOR EACH ROW EXECUTE FUNCTION "finance_tax_gl"();
CREATE TRIGGER "finance_tax_payments_gl" AFTER INSERT ON "finance_tax_payments"
  FOR EACH ROW EXECUTE FUNCTION "finance_tax_gl"();

-- ----------------------------------------------------------------------------
-- The fiscal year-end close.
-- ----------------------------------------------------------------------------
-- A year's entry, on its own day: the year's last, in a month closed by
-- then (the month checks let these two sources through, nothing else).
CREATE FUNCTION "gl_begin_year"(t uuid, src text, sid uuid, f date, ref text) RETURNS uuid
  LANGUAGE plpgsql AS $$
DECLARE
  e uuid := gen_random_uuid();
BEGIN
  INSERT INTO "gl_entries" ("id", "tenant_id", "posted_on", "event_on", "source", "source_id", "reference")
  VALUES (e, t, f, f, src, sid, ref);
  RETURN e;
END $$;

-- Each revenue and expense account's balance over the year (closings and
-- their reversals within it net to nothing) zeroed into accumulated
-- surplus, on the year's last day. Null when nothing is to close.
CREATE FUNCTION "gl_close_year"(t uuid, close uuid, s date, f date) RETURNS uuid
  LANGUAGE plpgsql AS $$
DECLARE
  e uuid;
  r record;
  result numeric := 0;
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM "gl_lines" l JOIN "gl_accounts" a ON a."tenant_id" = l."tenant_id" AND a."id" = l."account_id"
        WHERE l."tenant_id" = t AND l."posted_on" BETWEEN s AND f AND a."type" IN ('revenue', 'expense')
        GROUP BY l."account_id" HAVING SUM(l."debit") <> SUM(l."credit")) THEN
    RETURN NULL;
  END IF;
  e := "gl_begin_year"(t, 'year_close', close, f, 'FY-' || to_char(s, 'YYYY-MM'));
  FOR r IN SELECT l."account_id", SUM(l."debit") - SUM(l."credit") AS net
             FROM "gl_lines" l JOIN "gl_accounts" a ON a."tenant_id" = l."tenant_id" AND a."id" = l."account_id"
            WHERE l."tenant_id" = t AND l."posted_on" BETWEEN s AND f AND a."type" IN ('revenue', 'expense')
            GROUP BY l."account_id", a."code" HAVING SUM(l."debit") <> SUM(l."credit")
            ORDER BY a."code" LOOP
    PERFORM "gl_line"(t, e, r."account_id", -r."net");
    result := result - r."net";
  END LOOP;
  PERFORM "gl_line"(t, e, "gl_account"(t, 'accumulated_surplus'), -result);
  RETURN e;
END $$;

-- A reopening: the closing entry the other way round, on the same day.
CREATE FUNCTION "gl_reopen_year"(t uuid, close uuid, f date) RETURNS uuid
  LANGUAGE plpgsql AS $$
DECLARE
  e uuid;
BEGIN
  IF NOT "gl_posted"(t, 'year_close', close) THEN RETURN NULL; END IF;
  e := "gl_begin_year"(t, 'year_reopen', close, f,
                  (SELECT o."reference" FROM "gl_entries" o
                    WHERE o."tenant_id" = t AND o."source" = 'year_close' AND o."source_id" = close));
  PERFORM "gl_mirror"(t, e, 'year_close', close);
  RETURN e;
END $$;

-- ----------------------------------------------------------------------------
-- The backfill, recreated by the same rules (ADR 0092's, with the tax
-- columns and the taxes' own rows). A year's close and its reopening are
-- the manager's and the accountant's acts, not history: never backfilled.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "gl_backfill"(t uuid) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  tz text := COALESCE((SELECT s."timezone" FROM "tenant_settings" s WHERE s."tenant_id" = t),
                      'Africa/Cairo');
  bad int;
BEGIN
  PERFORM "gl_seed_chart"(t);
  CREATE TEMP TABLE IF NOT EXISTS "gl_stage" (
    src text, sid uuid, d date, ref text, n int, key text, amt numeric, unit uuid, vendor uuid
  ) ON COMMIT DROP;
  TRUNCATE "gl_stage";

  -- The originals.
  INSERT INTO "gl_stage"
  SELECT 'invoice', i."id", i."issued_on", "gl_ref"('INV', i."number"), v.*
    FROM "invoices" i
    CROSS JOIN LATERAL (VALUES (1, 'receivables', i."total", i."unit_id", NULL::uuid),
                               (2, 'revenue:' || i."kind"::text, -(i."total" - i."vat"), NULL, NULL),
                               (3, 'vat_payable', -i."vat", NULL, NULL)) v
   WHERE i."tenant_id" = t;
  INSERT INTO "gl_stage"
  SELECT 'credit_note', c."id", (c."created_at" AT TIME ZONE tz)::date, "gl_ref"('CN', c."number"), v.*
    FROM "credit_notes" c
    JOIN "invoices" i ON i."tenant_id" = c."tenant_id" AND i."id" = c."invoice_id"
    CROSS JOIN LATERAL (VALUES (1, 'revenue:' || i."kind"::text, c."amount" - c."vat", NULL::uuid, NULL::uuid),
                               (2, 'vat_payable', c."vat", NULL, NULL),
                               (3, 'receivables', -c."amount", i."unit_id", NULL)) v
   WHERE c."tenant_id" = t;
  INSERT INTO "gl_stage"
  SELECT 'payment', p."id", p."paid_on", "gl_ref"('RC', p."receipt_number"), v.*
    FROM "finance_payments" p
    CROSS JOIN LATERAL (VALUES
      (1, "gl_money_key"(p."method"::text), p."amount",
          CASE WHEN p."method" = 'deposit_offset' THEN p."unit_id" END, NULL::uuid),
      (2, 'unit_credit', -p."amount", p."unit_id", NULL)) v
   WHERE p."tenant_id" = t AND p."kind" = 'payment';
  INSERT INTO "gl_stage"
  SELECT 'allocation', a."id",
         CASE WHEN a."from_credit" THEN (a."created_at" AT TIME ZONE tz)::date ELSE p."paid_on" END,
         "gl_ref"('RC', p."receipt_number"), v.*
    FROM "finance_allocations" a
    JOIN "finance_payments" p ON p."tenant_id" = a."tenant_id" AND p."id" = a."payment_id"
    CROSS JOIN LATERAL (VALUES (1, 'unit_credit', a."amount", p."unit_id", NULL::uuid),
                               (2, 'receivables', -a."amount", p."unit_id", NULL)) v
   WHERE a."tenant_id" = t;
  INSERT INTO "gl_stage"
  SELECT 'allocation_release', x."id", (x."created_at" AT TIME ZONE tz)::date, "gl_ref"('CN', c."number"), v.*
    FROM "finance_allocation_releases" x
    JOIN "finance_allocations" a ON a."tenant_id" = x."tenant_id" AND a."id" = x."allocation_id"
    JOIN "finance_payments" p ON p."tenant_id" = a."tenant_id" AND p."id" = a."payment_id"
    JOIN "credit_notes" c ON c."tenant_id" = x."tenant_id" AND c."id" = x."credit_note_id"
    CROSS JOIN LATERAL (VALUES (1, 'receivables', x."amount", p."unit_id", NULL::uuid),
                               (2, 'unit_credit', -x."amount", p."unit_id", NULL)) v
   WHERE x."tenant_id" = t;
  INSERT INTO "gl_stage"
  SELECT 'refund', r."id", r."refunded_on", "gl_ref"('RF', r."number"), v.*
    FROM "finance_refunds" r
    CROSS JOIN LATERAL (VALUES (1, 'unit_credit', r."amount", r."unit_id", NULL::uuid),
                               (2, 'refunds_in_transit', -r."amount", NULL, NULL)) v
   WHERE r."tenant_id" = t AND r."kind" = 'refund';
  INSERT INTO "gl_stage"
  SELECT 'deposit', d."id", d."received_on", "gl_ref"('DP', d."number"), v.*
    FROM "finance_deposits" d
    CROSS JOIN LATERAL (VALUES (1, "gl_money_key"(d."method"), d."amount", NULL::uuid, NULL::uuid),
                               (2, 'deposits_held', -d."amount", d."unit_id", NULL)) v
   WHERE d."tenant_id" = t;
  INSERT INTO "gl_stage"
  SELECT 'deposit_event', x."id", (x."at" AT TIME ZONE tz)::date, "gl_ref"('DP', d."number"), v.*
    FROM "finance_deposit_events" x
    JOIN "finance_deposits" d ON d."tenant_id" = x."tenant_id" AND d."id" = x."deposit_id"
    CROSS JOIN LATERAL (VALUES
      (1, 'deposits_held', x."amount", d."unit_id", NULL::uuid),
      (2, CASE WHEN x."kind" = 'refunded' THEN 'refunds_in_transit'
               WHEN x."reason_code" = 'damage' THEN 'revenue:damage'
               ELSE 'income:deposits_retained' END, -x."amount", NULL, NULL)) v
   WHERE x."tenant_id" = t AND x."kind" IN ('refunded', 'deducted', 'forfeited')
     AND x."payment_id" IS NULL AND x."amount" IS NOT NULL;
  INSERT INTO "gl_stage"
  SELECT 'expense', x."id", x."spent_on", "gl_ref"('EX', x."number"), v.*
    FROM "finance_expenses" x
    LEFT JOIN "finance_budget_lines" b ON b."tenant_id" = x."tenant_id" AND b."id" = x."budget_line_id"
    CROSS JOIN LATERAL (VALUES (1, 'expense:' || COALESCE(b."category", 'other'), x."amount", NULL::uuid, x."vendor_id"),
                               (2, 'unregistered_payments', -x."amount", NULL, x."vendor_id")) v
   WHERE x."tenant_id" = t AND x."vendor_invoice_id" IS NULL;
  -- An invoice approved: approved or paid now, or called off after its
  -- approval (decided, never turned down).
  INSERT INTO "gl_stage"
  SELECT 'vendor_invoice', x."id", (x."decided_at" AT TIME ZONE tz)::date, "gl_ref"('VI', x."number"), v.*
    FROM "finance_vendor_invoices" x
    LEFT JOIN "finance_budget_lines" b ON b."tenant_id" = x."tenant_id" AND b."id" = x."budget_line_id"
    CROSS JOIN LATERAL (VALUES (1, 'expense:' || COALESCE(b."category", 'other'), x."total" - x."vat_recoverable",
                                NULL::uuid, x."vendor_id"),
                               (2, 'vat_receivable', x."vat_recoverable", NULL, x."vendor_id"),
                               (3, 'payables', -x."total", NULL, x."vendor_id")) v
   WHERE x."tenant_id" = t AND x."decided_at" IS NOT NULL AND x."reject_reason" IS NULL
     AND x."status" IN ('approved', 'paid', 'cancelled');
  INSERT INTO "gl_stage"
  SELECT 'vendor_payout', p."id", p."paid_on", "gl_ref"('VP', p."number"), v.*
    FROM "finance_vendor_payouts" p
    CROSS JOIN LATERAL (VALUES
      (1, CASE p."kind" WHEN 'advance' THEN 'vendor_advances'
                        WHEN 'retention_release' THEN 'retentions' ELSE 'payables' END,
          p."gross", NULL::uuid, p."vendor_id"),
      (2, 'retentions', -p."retention_held", NULL, p."vendor_id"),
      (3, 'vendor_advances', -p."advance_set_off", NULL, p."vendor_id"),
      (4, 'withholding_payable', -p."withholding", NULL, p."vendor_id"),
      (5, 'cash:' || p."cash_account_id"::text, -p."net", NULL, p."vendor_id")) v
   WHERE p."tenant_id" = t;
  INSERT INTO "gl_stage"
  SELECT 'vat_declaration', d."id", (d."declared_at" AT TIME ZONE tz)::date,
         'VAT-' || to_char(d."month", 'YYYY-MM'), v.*
    FROM "finance_vat_declarations" d
    CROSS JOIN LATERAL (VALUES (1, 'vat_payable', "gl_vat_offset"(d), NULL::uuid, NULL::uuid),
                               (2, 'vat_receivable', -"gl_vat_offset"(d), NULL, NULL)) v
   WHERE d."tenant_id" = t;
  INSERT INTO "gl_stage"
  SELECT 'tax_payment', p."id", p."paid_on", "gl_ref"('TXP', p."number"), v.*
    FROM "finance_tax_payments" p
    CROSS JOIN LATERAL (VALUES
      (1, CASE p."kind" WHEN 'vat' THEN 'vat_payable' ELSE 'withholding_payable' END, p."amount",
          NULL::uuid, NULL::uuid),
      (2, 'cash:' || p."cash_account_id"::text, -p."amount", NULL, NULL)) v
   WHERE p."tenant_id" = t;
  INSERT INTO "gl_stage"
  SELECT 'cash_movement', m."id", m."on_day", "gl_ref"('HI', h."number"), v.*
    FROM "finance_cash_movements" m
    LEFT JOIN "finance_custody_handins" h ON h."tenant_id" = m."tenant_id" AND h."id" = m."handin_id"
    CROSS JOIN LATERAL (VALUES
      (1, 'cash:' || m."account_id"::text, m."amount", NULL::uuid, NULL::uuid),
      (2, CASE m."kind"
            WHEN 'opening' THEN 'opening_balances'
            WHEN 'handin' THEN 'undeposited_cash'
            WHEN 'recovery' THEN 'expense:cash_over_short'
            WHEN 'transfer' THEN 'internal_transfers'
            WHEN 'cheque' THEN 'cheques_in_hand'
            WHEN 'statement_payment' THEN 'transfers_in_transit'
            ELSE CASE m."reason_code"
              WHEN 'bank_charge' THEN 'expense:bank_charges'
              WHEN 'interest' THEN 'income:interest'
              WHEN 'refund_paid' THEN 'refunds_in_transit'
              WHEN 'counting_correction' THEN 'expense:cash_over_short'
              ELSE 'suspense' END
          END, -m."amount", NULL, NULL)) v
   WHERE m."tenant_id" = t AND m."kind" NOT IN ('payout', 'tax_payment', 'reversal');
  INSERT INTO "gl_stage"
  SELECT 'custody_handin', h."id", h."received_on", "gl_ref"('HI', h."number"), v.*
    FROM "finance_custody_handins" h
    CROSS JOIN LATERAL (VALUES (1, 'expense:cash_over_short', -h."variance", NULL::uuid, NULL::uuid),
                               (2, 'undeposited_cash', h."variance", NULL, NULL)) v
   WHERE h."tenant_id" = t;
  INSERT INTO "gl_stage"
  SELECT 'club_payment', c."id", c."paid_on", left(c."receipt_number", 40), v.*
    FROM "club_payment_records" c
    CROSS JOIN LATERAL (VALUES (1, 'undeposited_cash', c."amount", NULL::uuid, NULL::uuid),
                               (2, 'revenue:club', -c."amount", NULL, NULL)) v
   WHERE c."tenant_id" = t AND c."kind" = 'payment' AND c."charge_id" IS NULL AND c."amount" IS NOT NULL;
  INSERT INTO "gl_stage"
  SELECT 'vehicle_fine_payment', f."id", f."paid_on", left(f."receipt_number", 40), v.*
    FROM "vehicle_fine_payments" f
    CROSS JOIN LATERAL (VALUES (1, 'undeposited_cash', f."amount", NULL::uuid, NULL::uuid),
                               (2, 'revenue:fine', -f."amount", NULL, NULL)) v
   WHERE f."tenant_id" = t AND f."kind" = 'payment' AND f."finance_payment_id" IS NULL
     AND f."amount" IS NOT NULL;
  INSERT INTO "gl_stage"
  SELECT 'violation_payment', x."id", x."paid_on", left(x."receipt_number", 40), v.*
    FROM "unit_violation_payments" x
    CROSS JOIN LATERAL (VALUES (1, 'undeposited_cash', x."amount", NULL::uuid, NULL::uuid),
                               (2, 'revenue:violation', -x."amount", NULL, NULL)) v
   WHERE x."tenant_id" = t AND x."kind" = 'payment' AND x."amount" IS NOT NULL;
  PERFORM "gl_backfill_flush"(t);

  -- What undoes them: the original's lines the other way round (and, for a
  -- payment, what it still paid owed again).
  INSERT INTO "gl_stage"
  SELECT 'payment_reversal', r."id", (r."created_at" AT TIME ZONE tz)::date, o."reference",
         l."line_no", a."system_key", l."credit" - l."debit", l."unit_id", l."vendor_id"
    FROM "finance_payments" r
    JOIN "gl_entries" o ON o."tenant_id" = r."tenant_id" AND o."source" = 'payment' AND o."source_id" = r."reverses_id"
    JOIN "gl_lines" l ON l."tenant_id" = o."tenant_id" AND l."entry_id" = o."id"
    JOIN "gl_accounts" a ON a."tenant_id" = l."tenant_id" AND a."id" = l."account_id"
   WHERE r."tenant_id" = t AND r."kind" = 'reversal';
  INSERT INTO "gl_stage"
  SELECT 'payment_reversal', r."id", (r."created_at" AT TIME ZONE tz)::date, o."reference", v.*
    FROM "finance_payments" r
    JOIN "finance_payments" p ON p."tenant_id" = r."tenant_id" AND p."id" = r."reverses_id"
    JOIN "gl_entries" o ON o."tenant_id" = r."tenant_id" AND o."source" = 'payment' AND o."source_id" = p."id"
    CROSS JOIN LATERAL (SELECT COALESCE(SUM(a."amount" - COALESCE((
             SELECT SUM(x."amount") FROM "finance_allocation_releases" x
              WHERE x."tenant_id" = a."tenant_id" AND x."allocation_id" = a."id"), 0)), 0) AS paid
        FROM "finance_allocations" a
       WHERE a."tenant_id" = p."tenant_id" AND a."payment_id" = p."id") q
    CROSS JOIN LATERAL (VALUES (10, 'receivables', q.paid, p."unit_id", NULL::uuid),
                               (11, 'unit_credit', -q.paid, p."unit_id", NULL)) v
   WHERE r."tenant_id" = t AND r."kind" = 'reversal';
  INSERT INTO "gl_stage"
  SELECT y.src, y.sid, y.d, o."reference", l."line_no", a."system_key", l."credit" - l."debit",
         l."unit_id", l."vendor_id"
    FROM (
      SELECT 'refund_reversal' AS src, r."id" AS sid, (r."created_at" AT TIME ZONE tz)::date AS d,
             'refund' AS osrc, r."reverses_id" AS oid
        FROM "finance_refunds" r WHERE r."tenant_id" = t AND r."kind" = 'reversal'
      UNION ALL
      SELECT 'expense_void', x."id", (x."voided_at" AT TIME ZONE tz)::date, 'expense', x."id"
        FROM "finance_expenses" x WHERE x."tenant_id" = t AND x."voided_at" IS NOT NULL
      UNION ALL
      SELECT 'vendor_invoice_cancel', x."id", (x."cancelled_at" AT TIME ZONE tz)::date, 'vendor_invoice', x."id"
        FROM "finance_vendor_invoices" x WHERE x."tenant_id" = t AND x."status" = 'cancelled'
      UNION ALL
      SELECT 'cash_movement', m."id", m."on_day", 'cash_movement', m."reverses_id"
        FROM "finance_cash_movements" m WHERE m."tenant_id" = t AND m."kind" = 'reversal'
      UNION ALL
      SELECT 'club_payment', c."id", (c."created_at" AT TIME ZONE tz)::date, 'club_payment', c."reverses_id"
        FROM "club_payment_records" c WHERE c."tenant_id" = t AND c."kind" = 'reversal'
      UNION ALL
      SELECT 'vehicle_fine_payment', f."id", (f."created_at" AT TIME ZONE tz)::date, 'vehicle_fine_payment', f."reverses_id"
        FROM "vehicle_fine_payments" f WHERE f."tenant_id" = t AND f."kind" = 'reversal'
      UNION ALL
      SELECT 'violation_payment', x."id", (x."created_at" AT TIME ZONE tz)::date, 'violation_payment', x."reverses_id"
        FROM "unit_violation_payments" x WHERE x."tenant_id" = t AND x."kind" = 'reversal'
    ) y
    JOIN "gl_entries" o ON o."tenant_id" = t AND o."source" = y.osrc AND o."source_id" = y.oid
    JOIN "gl_lines" l ON l."tenant_id" = o."tenant_id" AND l."entry_id" = o."id"
    JOIN "gl_accounts" a ON a."tenant_id" = l."tenant_id" AND a."id" = l."account_id";
  PERFORM "gl_backfill_flush"(t);

  -- What the set-aside checks would have refused.
  SELECT count(*) INTO bad FROM "gl_entries" e
    LEFT JOIN (SELECT l."entry_id", count(*) AS n, SUM(l."debit") AS dr, SUM(l."credit") AS cr,
                      bool_and(a."postable") AS ok
                 FROM "gl_lines" l JOIN "gl_accounts" a ON a."id" = l."account_id"
                WHERE l."tenant_id" = t GROUP BY l."entry_id") s ON s."entry_id" = e."id"
   WHERE e."tenant_id" = t AND e."txid" = txid_current()
     AND (COALESCE(s.n, 0) < 2 OR s.dr <> s.cr OR NOT s.ok);
  IF bad > 0 THEN
    RAISE EXCEPTION 'compound %: % backfilled entries do not balance', t, bad
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
