-- ============================================================================
-- The ledger complete from day one (ADR 0092): every compound gets the
-- standard chart (and an account for each of its bank and cash accounts),
-- then every money event already recorded posts at its own day, by the
-- rules of the posting functions (20270615090200). No month is closed yet.
--
-- A migration, not a sweep: the ledger is whole the moment the code that
-- posts to it runs, so no read ever sees half a history, and no month can
-- be closed over events still to post. Idempotent: each event posts once
-- (`gl_entries_source_key`), so running it again posts nothing new, and
-- what a failed run left is picked up where it stopped.
--
-- Set-based, for a large compound's history: each source's lines are
-- staged by one statement, then every staged entry and line is written by
-- two. The lines' per-row trigger and the entries' commit check are set
-- aside while it runs; one query per compound then checks what they would
-- have: every entry two lines at least, balanced, on postable accounts.
-- An event that undoes another (a reversal, a void, an approval called off)
-- mirrors the lines its original posted, so originals go first.
-- `test/gl/postings` holds the triggers' postings and this backfill's to
-- the same lines.
-- ============================================================================

CREATE FUNCTION "gl_backfill_flush"(t uuid) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "gl_entries" ("id", "tenant_id", "posted_on", "event_on", "source", "source_id", "reference")
  SELECT gen_random_uuid(), t, x.d, x.d, x.src, x.sid, x.ref
    FROM (SELECT DISTINCT s.src, s.sid, s.d, s.ref FROM "gl_stage" s WHERE s.amt <> 0) x
  ON CONFLICT ("tenant_id", "source", "source_id") DO NOTHING;
  INSERT INTO "gl_lines" ("tenant_id", "entry_id", "line_no", "account_id", "debit", "credit",
                          "unit_id", "vendor_id", "posted_on", "entry_seq")
  SELECT t, e."id", s.n, a."id", GREATEST(s.amt, 0), GREATEST(-s.amt, 0), s.unit, s.vendor,
         e."posted_on", e."seq"
    FROM "gl_stage" s
    JOIN "gl_entries" e ON e."tenant_id" = t AND e."source" = s.src AND e."source_id" = s.sid
                       AND e."txid" = txid_current()
    JOIN "gl_accounts" a ON a."tenant_id" = t AND a."system_key" = s.key
   WHERE s.amt <> 0
     -- An entry written already has its lines: only the ones just opened.
     AND NOT EXISTS (SELECT 1 FROM "gl_lines" x WHERE x."tenant_id" = t AND x."entry_id" = e."id");
  TRUNCATE "gl_stage";
END $$;

CREATE FUNCTION "gl_backfill"(t uuid) RETURNS void
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
                               (2, 'revenue:' || i."kind"::text, -i."total", NULL, NULL)) v
   WHERE i."tenant_id" = t;
  INSERT INTO "gl_stage"
  SELECT 'credit_note', c."id", (c."created_at" AT TIME ZONE tz)::date, "gl_ref"('CN', c."number"), v.*
    FROM "credit_notes" c
    JOIN "invoices" i ON i."tenant_id" = c."tenant_id" AND i."id" = c."invoice_id"
    CROSS JOIN LATERAL (VALUES (1, 'revenue:' || i."kind"::text, c."amount", NULL::uuid, NULL::uuid),
                               (2, 'receivables', -c."amount", i."unit_id", NULL)) v
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
    CROSS JOIN LATERAL (VALUES (1, 'expense:' || COALESCE(b."category", 'other'), x."total", NULL::uuid, x."vendor_id"),
                               (2, 'payables', -x."total", NULL, x."vendor_id")) v
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
      (4, 'cash:' || p."cash_account_id"::text, -p."net", NULL, p."vendor_id")) v
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
   WHERE m."tenant_id" = t AND m."kind" NOT IN ('payout', 'reversal');
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

ALTER TABLE "gl_lines" DISABLE TRIGGER "gl_lines_of_entry";
ALTER TABLE "gl_entries" DISABLE TRIGGER "gl_entries_balanced";

DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" ORDER BY "id" LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM "gl_backfill"(t);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

ALTER TABLE "gl_lines" ENABLE TRIGGER "gl_lines_of_entry";
ALTER TABLE "gl_entries" ENABLE TRIGGER "gl_entries_balanced";
