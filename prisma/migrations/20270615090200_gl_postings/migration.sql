-- ============================================================================
-- Automatic postings (ADR 0092). Every money event the app records lands in
-- an append-only row (or a row's one-way status), so it posts its entry in
-- the same transaction, by a trigger on that row, whatever path wrote it:
-- finance's, the gate's (fines, violations) or the facilities' (the club).
-- The backfill (20270615090300) calls the same functions over history.
--
-- Accrual basis. A unit's money: an invoice debits receivables and credits
-- its kind's revenue; a credit note the reverse; a payment debits where the
-- money is (by its method) and credits the unit's credit; an allocation
-- moves the unit's credit onto its invoice (debit credit, credit
-- receivables), a release back; a reversal undoes its payment and what it
-- still paid. A refund takes the unit's credit out. A deposit is held as a
-- liability until refunded, deducted or forfeited.
-- Money in transit: office cash waits in `undeposited_cash` until a
-- hand-in counts it into a cash box (its variance to cash over and short),
-- a cheque in `cheques_in_hand` until it clears, an office bank transfer in
-- `transfers_in_transit` until a statement line matches it, an online
-- payment in `gateway_receivable`.
-- Payables: an invoice approved is an expense of its line's category owed
-- to its vendor; its payout pays it, holding back retention and setting off
-- advances; an advance paid is the vendor's debt, a retention released pays
-- what was held. A manual expense (ADR 0055) was paid outside the treasury.
-- The treasury: each movement on its account against where it came from.
--
-- Each entry is dated on its event's day; when that month is closed, on the
-- first day of the next open month (`event_on` keeps the event's day).
-- ============================================================================

-- The compound's local day of an instant.
CREATE FUNCTION "gl_local_day"(t uuid, at timestamptz) RETURNS date
  LANGUAGE sql STABLE AS $$
  SELECT (at AT TIME ZONE COALESCE(
    (SELECT s."timezone" FROM "tenant_settings" s WHERE s."tenant_id" = t), 'Africa/Cairo'))::date
$$;

CREATE FUNCTION "gl_ref"(prefix text, n int) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN n IS NULL THEN NULL ELSE prefix || '-' || lpad(n::text, 6, '0') END
$$;

-- The day an automatic entry takes: its own, or the first day of the next
-- open month after a closed one.
CREATE FUNCTION "gl_open_on"(t uuid, d date) RETURNS date
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  m date := date_trunc('month', d)::date;
BEGIN
  IF NOT "gl_month_closed"(t, d) THEN RETURN d; END IF;
  LOOP
    m := (m + interval '1 month')::date;
    EXIT WHEN NOT "gl_month_closed"(t, m);
  END LOOP;
  RETURN m;
END $$;

-- Opens an event's entry, once: null when the event posted already.
CREATE FUNCTION "gl_begin"(t uuid, src text, sid uuid, ev date, ref text) RETURNS uuid
  LANGUAGE plpgsql AS $$
DECLARE
  e uuid := gen_random_uuid();
BEGIN
  INSERT INTO "gl_entries" ("id", "tenant_id", "posted_on", "event_on", "source", "source_id", "reference")
  VALUES (e, t, "gl_open_on"(t, ev), ev, src, sid, ref)
  ON CONFLICT ("tenant_id", "source", "source_id") DO NOTHING;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN e;
END $$;

-- A line: a positive amount debits, a negative one credits, zero writes
-- nothing.
CREATE FUNCTION "gl_line"(t uuid, e uuid, acct uuid, amt numeric,
                          unit uuid DEFAULT NULL, vendor uuid DEFAULT NULL) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  IF e IS NULL OR amt IS NULL OR amt = 0 THEN RETURN; END IF;
  INSERT INTO "gl_lines" ("tenant_id", "entry_id", "line_no", "account_id", "debit", "credit",
                          "unit_id", "vendor_id", "posted_on", "entry_seq")
  VALUES (t, e,
          (SELECT COALESCE(MAX(l."line_no"), 0) + 1 FROM "gl_lines" l
            WHERE l."tenant_id" = t AND l."entry_id" = e),
          acct, GREATEST(amt, 0), GREATEST(-amt, 0), unit, vendor, '1970-01-01', 0);
END $$;

-- The lines of another event's entry, the other way round.
CREATE FUNCTION "gl_mirror"(t uuid, e uuid, src text, sid uuid) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  l record;
BEGIN
  FOR l IN SELECT x.* FROM "gl_lines" x JOIN "gl_entries" o
             ON o."tenant_id" = x."tenant_id" AND o."id" = x."entry_id"
            WHERE o."tenant_id" = t AND o."source" = src AND o."source_id" = sid
            ORDER BY x."line_no" LOOP
    PERFORM "gl_line"(t, e, l."account_id", l."credit" - l."debit", l."unit_id", l."vendor_id");
  END LOOP;
END $$;

CREATE FUNCTION "gl_posted"(t uuid, src text, sid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "gl_entries" e
                  WHERE e."tenant_id" = t AND e."source" = src AND e."source_id" = sid)
$$;

-- Where a unit's money is, by how it was paid.
CREATE FUNCTION "gl_money_key"(method text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE method
    WHEN 'cash' THEN 'undeposited_cash'
    WHEN 'bank_transfer' THEN 'transfers_in_transit'
    WHEN 'cheque' THEN 'cheques_in_hand'
    WHEN 'card' THEN 'gateway_receivable'
    WHEN 'wallet' THEN 'gateway_receivable'
    WHEN 'deposit_offset' THEN 'deposits_held'
    ELSE 'suspense' END
$$;

-- ----------------------------------------------------------------------------
-- A unit's money (ADR 0046, 0048, 0062).
-- ----------------------------------------------------------------------------
CREATE FUNCTION "gl_post_invoice"(i "invoices") RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  e uuid;
BEGIN
  IF i."total" = 0 THEN RETURN; END IF;
  e := "gl_begin"(i."tenant_id", 'invoice', i."id", i."issued_on", "gl_ref"('INV', i."number"));
  PERFORM "gl_line"(i."tenant_id", e, "gl_account"(i."tenant_id", 'receivables'), i."total", i."unit_id");
  PERFORM "gl_line"(i."tenant_id", e, "gl_account"(i."tenant_id", 'revenue:' || i."kind"::text), -i."total");
END $$;

CREATE FUNCTION "gl_post_credit_note"(c "credit_notes") RETURNS void
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
  PERFORM "gl_line"(c."tenant_id", e, "gl_account"(c."tenant_id", 'revenue:' || i."kind"::text), c."amount");
  PERFORM "gl_line"(c."tenant_id", e, "gl_account"(c."tenant_id", 'receivables'), -c."amount", i."unit_id");
END $$;

CREATE FUNCTION "gl_post_payment"(p "finance_payments") RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  o record;
  e uuid;
  paid numeric;
BEGIN
  IF p."kind" = 'payment' THEN
    IF p."amount" = 0 THEN RETURN; END IF;
    e := "gl_begin"(p."tenant_id", 'payment', p."id", p."paid_on", "gl_ref"('RC', p."receipt_number"));
    PERFORM "gl_line"(p."tenant_id", e, "gl_account"(p."tenant_id", "gl_money_key"(p."method"::text)),
                      p."amount", CASE WHEN p."method" = 'deposit_offset' THEN p."unit_id" END);
    PERFORM "gl_line"(p."tenant_id", e, "gl_account"(p."tenant_id", 'unit_credit'), -p."amount", p."unit_id");
    RETURN;
  END IF;
  -- A reversal: the payment undone, and what it still paid owed again.
  SELECT x."receipt_number", x."unit_id" INTO o FROM "finance_payments" x
   WHERE x."tenant_id" = p."tenant_id" AND x."id" = p."reverses_id";
  IF NOT "gl_posted"(p."tenant_id", 'payment', p."reverses_id") THEN RETURN; END IF;
  e := "gl_begin"(p."tenant_id", 'payment_reversal', p."id", "gl_local_day"(p."tenant_id", p."created_at"),
                  "gl_ref"('RC', o."receipt_number"));
  PERFORM "gl_mirror"(p."tenant_id", e, 'payment', p."reverses_id");
  SELECT COALESCE(SUM(a."amount" - COALESCE((
           SELECT SUM(r."amount") FROM "finance_allocation_releases" r
            WHERE r."tenant_id" = a."tenant_id" AND r."allocation_id" = a."id"), 0)), 0)
    INTO paid
    FROM "finance_allocations" a
   WHERE a."tenant_id" = p."tenant_id" AND a."payment_id" = p."reverses_id";
  PERFORM "gl_line"(p."tenant_id", e, "gl_account"(p."tenant_id", 'receivables'), paid, o."unit_id");
  PERFORM "gl_line"(p."tenant_id", e, "gl_account"(p."tenant_id", 'unit_credit'), -paid, o."unit_id");
END $$;

-- An allocation in its payment's own call counts on the payment's day; one
-- poured from credit the unit held, on the day it was poured.
CREATE FUNCTION "gl_post_allocation"(a "finance_allocations") RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  p record;
  e uuid;
BEGIN
  IF a."amount" = 0 THEN RETURN; END IF;
  SELECT x."paid_on", x."receipt_number", x."unit_id" INTO p FROM "finance_payments" x
   WHERE x."tenant_id" = a."tenant_id" AND x."id" = a."payment_id";
  e := "gl_begin"(a."tenant_id", 'allocation', a."id",
                  CASE WHEN a."from_credit" THEN "gl_local_day"(a."tenant_id", a."created_at")
                       ELSE p."paid_on" END,
                  "gl_ref"('RC', p."receipt_number"));
  PERFORM "gl_line"(a."tenant_id", e, "gl_account"(a."tenant_id", 'unit_credit'), a."amount", p."unit_id");
  PERFORM "gl_line"(a."tenant_id", e, "gl_account"(a."tenant_id", 'receivables'), -a."amount", p."unit_id");
END $$;

CREATE FUNCTION "gl_post_allocation_release"(x "finance_allocation_releases") RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  unit uuid;
  cn int;
  e uuid;
BEGIN
  IF x."amount" = 0 THEN RETURN; END IF;
  SELECT p."unit_id" INTO unit FROM "finance_allocations" a
    JOIN "finance_payments" p ON p."tenant_id" = a."tenant_id" AND p."id" = a."payment_id"
   WHERE a."tenant_id" = x."tenant_id" AND a."id" = x."allocation_id";
  SELECT c."number" INTO cn FROM "credit_notes" c
   WHERE c."tenant_id" = x."tenant_id" AND c."id" = x."credit_note_id";
  e := "gl_begin"(x."tenant_id", 'allocation_release', x."id", "gl_local_day"(x."tenant_id", x."created_at"),
                  "gl_ref"('CN', cn));
  PERFORM "gl_line"(x."tenant_id", e, "gl_account"(x."tenant_id", 'receivables'), x."amount", unit);
  PERFORM "gl_line"(x."tenant_id", e, "gl_account"(x."tenant_id", 'unit_credit'), -x."amount", unit);
END $$;

CREATE FUNCTION "gl_post_refund"(r "finance_refunds") RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  n int;
  e uuid;
BEGIN
  IF r."kind" = 'refund' THEN
    IF r."amount" = 0 THEN RETURN; END IF;
    e := "gl_begin"(r."tenant_id", 'refund', r."id", r."refunded_on", "gl_ref"('RF', r."number"));
    PERFORM "gl_line"(r."tenant_id", e, "gl_account"(r."tenant_id", 'unit_credit'), r."amount", r."unit_id");
    PERFORM "gl_line"(r."tenant_id", e, "gl_account"(r."tenant_id", 'refunds_in_transit'), -r."amount");
    RETURN;
  END IF;
  IF NOT "gl_posted"(r."tenant_id", 'refund', r."reverses_id") THEN RETURN; END IF;
  SELECT x."number" INTO n FROM "finance_refunds" x
   WHERE x."tenant_id" = r."tenant_id" AND x."id" = r."reverses_id";
  e := "gl_begin"(r."tenant_id", 'refund_reversal', r."id", "gl_local_day"(r."tenant_id", r."created_at"),
                  "gl_ref"('RF', n));
  PERFORM "gl_mirror"(r."tenant_id", e, 'refund', r."reverses_id");
END $$;

CREATE FUNCTION "gl_post_deposit"(d "finance_deposits") RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  e uuid;
BEGIN
  IF d."amount" = 0 THEN RETURN; END IF;
  e := "gl_begin"(d."tenant_id", 'deposit', d."id", d."received_on", "gl_ref"('DP', d."number"));
  PERFORM "gl_line"(d."tenant_id", e, "gl_account"(d."tenant_id", "gl_money_key"(d."method")), d."amount");
  PERFORM "gl_line"(d."tenant_id", e, "gl_account"(d."tenant_id", 'deposits_held'), -d."amount", d."unit_id");
END $$;

-- A refund pays it back; a deduction for unpaid dues is its office payment
-- (posted by the payment); any other deduction or a forfeit is income — a
-- damage's as the damage claims' revenue.
CREATE FUNCTION "gl_post_deposit_event"(v "finance_deposit_events") RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  d record;
  e uuid;
  other text;
BEGIN
  IF v."kind" NOT IN ('refunded', 'deducted', 'forfeited') OR v."payment_id" IS NOT NULL
     OR v."amount" IS NULL OR v."amount" = 0 THEN
    RETURN;
  END IF;
  SELECT x."number", x."unit_id" INTO d FROM "finance_deposits" x
   WHERE x."tenant_id" = v."tenant_id" AND x."id" = v."deposit_id";
  other := CASE WHEN v."kind" = 'refunded' THEN 'refunds_in_transit'
                WHEN v."reason_code" = 'damage' THEN 'revenue:damage'
                ELSE 'income:deposits_retained' END;
  e := "gl_begin"(v."tenant_id", 'deposit_event', v."id", "gl_local_day"(v."tenant_id", v."at"),
                  "gl_ref"('DP', d."number"));
  PERFORM "gl_line"(v."tenant_id", e, "gl_account"(v."tenant_id", 'deposits_held'), v."amount", d."unit_id");
  PERFORM "gl_line"(v."tenant_id", e, "gl_account"(v."tenant_id", other), -v."amount");
END $$;

-- ----------------------------------------------------------------------------
-- What the compound spends (ADR 0055, 0089).
-- ----------------------------------------------------------------------------
CREATE FUNCTION "gl_expense_key"(t uuid, line uuid) RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT 'expense:' || COALESCE(
    (SELECT l."category" FROM "finance_budget_lines" l WHERE l."tenant_id" = t AND l."id" = line),
    'other')
$$;

-- A payout's expense is its invoice's, posted when the invoice was approved.
CREATE FUNCTION "gl_post_expense"(x "finance_expenses") RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  e uuid;
BEGIN
  IF x."vendor_invoice_id" IS NOT NULL OR x."amount" = 0 THEN RETURN; END IF;
  e := "gl_begin"(x."tenant_id", 'expense', x."id", x."spent_on", "gl_ref"('EX', x."number"));
  PERFORM "gl_line"(x."tenant_id", e, "gl_account"(x."tenant_id", "gl_expense_key"(x."tenant_id", x."budget_line_id")),
                    x."amount", NULL, x."vendor_id");
  PERFORM "gl_line"(x."tenant_id", e, "gl_account"(x."tenant_id", 'unregistered_payments'), -x."amount",
                    NULL, x."vendor_id");
END $$;

CREATE FUNCTION "gl_post_expense_void"(x "finance_expenses") RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  e uuid;
BEGIN
  IF x."voided_at" IS NULL OR NOT "gl_posted"(x."tenant_id", 'expense', x."id") THEN RETURN; END IF;
  e := "gl_begin"(x."tenant_id", 'expense_void', x."id", "gl_local_day"(x."tenant_id", x."voided_at"),
                  "gl_ref"('EX', x."number"));
  PERFORM "gl_mirror"(x."tenant_id", e, 'expense', x."id");
END $$;

CREATE FUNCTION "gl_post_vendor_invoice"(v "finance_vendor_invoices") RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  e uuid;
BEGIN
  IF v."total" = 0 THEN RETURN; END IF;
  e := "gl_begin"(v."tenant_id", 'vendor_invoice', v."id", "gl_local_day"(v."tenant_id", v."decided_at"),
                  "gl_ref"('VI', v."number"));
  PERFORM "gl_line"(v."tenant_id", e, "gl_account"(v."tenant_id", "gl_expense_key"(v."tenant_id", v."budget_line_id")),
                    v."total", NULL, v."vendor_id");
  PERFORM "gl_line"(v."tenant_id", e, "gl_account"(v."tenant_id", 'payables'), -v."total", NULL, v."vendor_id");
END $$;

CREATE FUNCTION "gl_post_vendor_invoice_cancel"(v "finance_vendor_invoices") RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  e uuid;
BEGIN
  IF NOT "gl_posted"(v."tenant_id", 'vendor_invoice', v."id") THEN RETURN; END IF;
  e := "gl_begin"(v."tenant_id", 'vendor_invoice_cancel', v."id",
                  "gl_local_day"(v."tenant_id", v."cancelled_at"), "gl_ref"('VI', v."number"));
  PERFORM "gl_mirror"(v."tenant_id", e, 'vendor_invoice', v."id");
END $$;

-- An invoice's payout pays what is owed, holds back retention, sets off
-- advances, and the rest leaves its account; an advance becomes the
-- vendor's debt; a release pays the retention held. Its account's line is
-- its `payout` movement (which posts nothing of its own).
CREATE FUNCTION "gl_post_vendor_payout"(p "finance_vendor_payouts") RETURNS void
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
  IF p."net" > 0 THEN
    PERFORM "gl_line"(p."tenant_id", e, "gl_cash_account"(p."tenant_id", p."cash_account_id"), -p."net",
                      NULL, p."vendor_id");
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- The treasury (ADR 0085).
-- ----------------------------------------------------------------------------
CREATE FUNCTION "gl_post_cash_movement"(m "finance_cash_movements") RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  e uuid;
  other text;
BEGIN
  IF m."kind" = 'payout' THEN RETURN; END IF;
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

-- What a hand-in counted moved into its box with its movement; what it was
-- short of (or over) what was expected leaves the office cash for cash over
-- and short.
CREATE FUNCTION "gl_post_custody_handin"(h "finance_custody_handins") RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  e uuid;
BEGIN
  IF h."variance" = 0 THEN RETURN; END IF;
  e := "gl_begin"(h."tenant_id", 'custody_handin', h."id", h."received_on", "gl_ref"('HI', h."number"));
  PERFORM "gl_line"(h."tenant_id", e, "gl_account"(h."tenant_id", 'expense:cash_over_short'), -h."variance");
  PERFORM "gl_line"(h."tenant_id", e, "gl_account"(h."tenant_id", 'undeposited_cash'), h."variance");
END $$;

-- ----------------------------------------------------------------------------
-- Office money outside finance's invoices: the club's own records (one a
-- paid charge wrote is finance's already), a fine paid at the office before
-- fines were charged (ADR 0070), a violation's payment (ADR 0053). Revenue
-- when collected; office cash.
-- ----------------------------------------------------------------------------
CREATE FUNCTION "gl_post_office_record"(t uuid, src text, sid uuid, kind text, amt numeric,
                                        paid date, created timestamptz, reverses uuid,
                                        ref text, revenue text) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  e uuid;
BEGIN
  IF kind = 'payment' THEN
    IF amt IS NULL OR amt = 0 THEN RETURN; END IF;
    e := "gl_begin"(t, src, sid, paid, ref);
    PERFORM "gl_line"(t, e, "gl_account"(t, 'undeposited_cash'), amt);
    PERFORM "gl_line"(t, e, "gl_account"(t, revenue), -amt);
    RETURN;
  END IF;
  IF NOT "gl_posted"(t, src, reverses) THEN RETURN; END IF;
  e := "gl_begin"(t, src, sid, "gl_local_day"(t, created), ref);
  PERFORM "gl_mirror"(t, e, src, reverses);
END $$;

CREATE FUNCTION "gl_post_club_payment"(c "club_payment_records") RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  IF c."charge_id" IS NOT NULL THEN RETURN; END IF;
  PERFORM "gl_post_office_record"(c."tenant_id", 'club_payment', c."id", c."kind"::text, c."amount",
    c."paid_on", c."created_at", c."reverses_id",
    left(COALESCE(c."receipt_number",
                  (SELECT r."receipt_number" FROM "club_payment_records" r
                    WHERE r."tenant_id" = c."tenant_id" AND r."id" = c."reverses_id")), 40),
    'revenue:club');
END $$;

CREATE FUNCTION "gl_post_vehicle_fine_payment"(f "vehicle_fine_payments") RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  IF f."finance_payment_id" IS NOT NULL THEN RETURN; END IF;
  PERFORM "gl_post_office_record"(f."tenant_id", 'vehicle_fine_payment', f."id", f."kind"::text, f."amount",
    f."paid_on", f."created_at", f."reverses_id",
    left(COALESCE(f."receipt_number",
                  (SELECT r."receipt_number" FROM "vehicle_fine_payments" r
                    WHERE r."tenant_id" = f."tenant_id" AND r."id" = f."reverses_id")), 40),
    'revenue:fine');
END $$;

CREATE FUNCTION "gl_post_violation_payment"(v "unit_violation_payments") RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "gl_post_office_record"(v."tenant_id", 'violation_payment', v."id", v."kind", v."amount",
    v."paid_on", v."created_at", v."reverses_id",
    left(COALESCE(v."receipt_number",
                  (SELECT r."receipt_number" FROM "unit_violation_payments" r
                    WHERE r."tenant_id" = v."tenant_id" AND r."id" = v."reverses_id")), 40),
    'revenue:violation');
END $$;

-- ----------------------------------------------------------------------------
-- The triggers: each in the event's own transaction.
-- ----------------------------------------------------------------------------
CREATE FUNCTION "gl_on_insert"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'invoices' THEN PERFORM "gl_post_invoice"(NEW);
  ELSIF TG_TABLE_NAME = 'credit_notes' THEN PERFORM "gl_post_credit_note"(NEW);
  ELSIF TG_TABLE_NAME = 'finance_payments' THEN PERFORM "gl_post_payment"(NEW);
  ELSIF TG_TABLE_NAME = 'finance_allocations' THEN PERFORM "gl_post_allocation"(NEW);
  ELSIF TG_TABLE_NAME = 'finance_allocation_releases' THEN PERFORM "gl_post_allocation_release"(NEW);
  ELSIF TG_TABLE_NAME = 'finance_refunds' THEN PERFORM "gl_post_refund"(NEW);
  ELSIF TG_TABLE_NAME = 'finance_deposits' THEN PERFORM "gl_post_deposit"(NEW);
  ELSIF TG_TABLE_NAME = 'finance_deposit_events' THEN PERFORM "gl_post_deposit_event"(NEW);
  ELSIF TG_TABLE_NAME = 'finance_expenses' THEN PERFORM "gl_post_expense"(NEW);
  ELSIF TG_TABLE_NAME = 'finance_vendor_payouts' THEN PERFORM "gl_post_vendor_payout"(NEW);
  ELSIF TG_TABLE_NAME = 'finance_cash_movements' THEN PERFORM "gl_post_cash_movement"(NEW);
  ELSIF TG_TABLE_NAME = 'finance_custody_handins' THEN PERFORM "gl_post_custody_handin"(NEW);
  ELSIF TG_TABLE_NAME = 'club_payment_records' THEN PERFORM "gl_post_club_payment"(NEW);
  ELSIF TG_TABLE_NAME = 'vehicle_fine_payments' THEN PERFORM "gl_post_vehicle_fine_payment"(NEW);
  ELSIF TG_TABLE_NAME = 'unit_violation_payments' THEN PERFORM "gl_post_violation_payment"(NEW);
  END IF;
  RETURN NULL;
END $$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices', 'credit_notes', 'finance_payments', 'finance_allocations',
                           'finance_allocation_releases', 'finance_refunds', 'finance_deposits',
                           'finance_deposit_events', 'finance_expenses', 'finance_vendor_payouts',
                           'finance_cash_movements', 'finance_custody_handins', 'club_payment_records',
                           'vehicle_fine_payments', 'unit_violation_payments'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON %I FOR EACH ROW EXECUTE FUNCTION "gl_on_insert"()',
                   t || '_gl', t);
  END LOOP;
END $$;

-- An expense voided; a vendor's invoice approved, or called off after it.
CREATE FUNCTION "finance_expenses_gl_void"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "gl_post_expense_void"(NEW);
  RETURN NULL;
END $$;
CREATE TRIGGER "finance_expenses_gl_void" AFTER UPDATE OF "voided_at" ON "finance_expenses"
  FOR EACH ROW WHEN (OLD."voided_at" IS NULL AND NEW."voided_at" IS NOT NULL)
  EXECUTE FUNCTION "finance_expenses_gl_void"();

CREATE FUNCTION "finance_vendor_invoices_gl"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'approved' THEN
    PERFORM "gl_post_vendor_invoice"(NEW);
  ELSIF NEW."status" = 'cancelled' AND OLD."status" = 'approved' THEN
    PERFORM "gl_post_vendor_invoice_cancel"(NEW);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER "finance_vendor_invoices_gl" AFTER UPDATE OF "status" ON "finance_vendor_invoices"
  FOR EACH ROW WHEN (OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION "finance_vendor_invoices_gl"();
