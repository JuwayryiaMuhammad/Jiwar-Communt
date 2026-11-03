-- ============================================================================
-- The migrate-with-data seed (ADR 0061): two compounds that hold what
-- migrations most often have to carry, loaded as the superuser (RLS does not
-- apply; triggers fire). The job loads the BASE commit's copy of this file
-- on the base schema, applies the branch's migrations over it, then loads
-- the branch's copy on the new schema: a migration that changes a table used
-- here must keep this file loading. Names carry a random suffix and every id
-- is drawn here, so the file loads any number of times.
--
-- Per compound: three roles, a manager, two residents and a guard; two
-- units; its settings; a gate with a night roster and slots from it; app
-- and browser devices; visitor passes (active, used, cancelled);
-- guard instructions (sent before validity existed, scheduled, already
-- told) with recipients; an invoice with its line, and an office payment;
-- a pending registration (its personal data) and a rejected one (none);
-- files owned and pending, owned and ready, and attached to a record;
-- maintenance categories (the second compound has no `general`) and two
-- open tickets, one in a unit and one in a common area; a pending move
-- permit and a pending works permit, an open inspection task of a unit, and
-- (the first compound) a `utilities` topic of the management's own; a
-- bookable court with a confirmed booking and one the staff cancelled, an
-- emergency from a unit and an incident at it (ADR 0067 widens their
-- CHECKs and recreates their triggers); occupancies (a residing owner, a
-- landlord, a tenant who bought the unit), the finance settings, a billing
-- plan, an invoice's notice and a conduct guide's version (ADR 0069 backfills
-- `resides_since` and widens their columns and CHECKs);
-- the gate's settings, and a banned person with a photo met at the gate
-- twice (ADR 0068 adds the settings' face-check switch and call times,
-- widens the matches' CHECKs and recreates the files');
-- (ADR 0077) a vendor, a contract naming it with its terms and payments,
-- and a purchase request; (ADR 0089) a terminated contract with a
-- retention share, the variance setting, a payables counter and an
-- inbox overdue mark;
-- a staff credit note, a vehicle fine paid at the office and a club plan
-- with a membership paid at the office (ADR 0070 lets a credit note's author
-- and a club payment's recorder be null, rewrites their CHECKs, links a fine
-- payment to finance's, and recreates the facilities' and bookings' shape
-- and window CHECKs and the bookings' trigger).
-- Community (ADR 0071): the gate's directions and busy thresholds, a
-- recurring pass told of no entry and expected at the gate, standing
-- instructions with and without their notice, an emergency raised from a
-- common area, the compound's place for prayer times, an emergency guide,
-- a booking held now, and a lending post and a live listing each with its
-- masked conversation (exactly one subject each).
-- Spaces (ADR 0084): the permits' days off, moved into the holiday calendar
-- by the branch's migration; on the new schema, a holiday, an area open to
-- use requests and a pending request.
-- The unit register (ADR 0072): a building ahead of its units, a unit put
-- in it by id and one named by text, and a valid units import on its sheet
-- (the base's units, named by text, are backfilled into buildings).
-- The inbox, the authority and the deputy (ADR 0073): the board's settings
-- with the major contract's and a waiver's thresholds binding, a due time
-- of the inbox's own, a live deputy, and an audit entry taken on its
-- principal's behalf (`binding` and `on_behalf_of_id` are new columns of
-- existing tables).
-- Dispatch depth (ADR 0076): the SLA's settings with an escalation level
-- turned off, an asset whose warranty starts, ends and names its warrantor,
-- a work order of the management's own on it, and an open claim under its
-- warranty.
-- A scheduled inspection request whose task was cancelled when its guard
-- left (20270511090000 cancels the request with it).
-- Fit-out (ADR 0074): the compound's deposit rule, a finishing-works
-- deposit naming the works permit and a move deposit naming none.
-- Maintenance analytics (ADR 0081): two more repairs on the pump (three of
-- one category on one asset, what a plan suggestion counts) and two
-- residents' tickets of one category in a building's units (what a case
-- counts): `tickets` gains `sensitive` and `maintenance_settings` its
-- analytics' numbers, both with defaults, over these rows.
-- The board's work (ADR 0075): a sitting board with its handover pack, a
-- meeting held with its agenda, attendance and an open action item, a
-- unit's ownership share, the governance rules, a manager's delivered
-- handover and a month's board report.
-- Transfers, closed units and the market (ADR 0083): a confirmed group
-- offer with a participant, and a proxy its owner revoked (the offers' and
-- participants' triggers are recreated, the proxies gain `revoke_code`).
-- ============================================================================

DO $$
DECLARE
  c int;
  s text;
  t uuid; r_res uuid; r_staff uuid; r_mgr uuid;
  mgr uuid; res1 uuid; res2 uuid; guard uuid;
  u1 uuid; u2 uuid;
  i_old uuid; i_sched uuid; i_told uuid;
  gate uuid; tpl uuid; night timestamptz;
  batch uuid; inv uuid;
  h text;
  lp text;
  cat uuid;
  area uuid; doc uuid;
  fac uuid;
  occ_t uuid;
  ph uuid; bl uuid; vp uuid;
  fine uuid; plan uuid; mem uuid;
  wp uuid;
BEGIN
  FOR c IN 1..2 LOOP
    s := substr(md5(random()::text || clock_timestamp()::text), 1, 10);
    t := gen_random_uuid();
    INSERT INTO tenants (id, name) VALUES (t, 'Seed Court ' || s);

    r_res := gen_random_uuid(); r_staff := gen_random_uuid(); r_mgr := gen_random_uuid();
    INSERT INTO roles (id, tenant_id, key, kind, updated_at) VALUES
      (r_res, t, 'resident', 'resident', now()),
      (r_staff, t, 'guard', 'staff', now()),
      (r_mgr, t, 'manager', 'manager', now());

    mgr := gen_random_uuid(); res1 := gen_random_uuid();
    res2 := gen_random_uuid(); guard := gen_random_uuid();
    INSERT INTO accounts (id, tenant_id, type, role_id, full_name, phone, email,
                          id_document_type, id_document_number, nationality, updated_at) VALUES
      (mgr, t, 'manager', r_mgr, 'Seed Manager', '+2010' || lpad(c::text, 2, '0') || '0000001',
       'mgr-' || s || '@seed.test', 'national_id', '2900101' || lpad(c::text, 2, '0') || '00011', 'EG', now()),
      (res1, t, 'resident', r_res, 'Seed Resident One', '+2010' || lpad(c::text, 2, '0') || '0000002',
       'res1-' || s || '@seed.test', 'national_id', '2900101' || lpad(c::text, 2, '0') || '00021', 'EG', now()),
      (res2, t, 'resident', r_res, 'Seed Resident Two', '+2010' || lpad(c::text, 2, '0') || '0000003',
       'res2-' || s || '@seed.test', 'national_id', '2900101' || lpad(c::text, 2, '0') || '00031', 'EG', now()),
      (guard, t, 'staff', r_staff, 'Seed Guard', '+2010' || lpad(c::text, 2, '0') || '0000004',
       'guard-' || s || '@seed.test', 'national_id', '2900101' || lpad(c::text, 2, '0') || '00041', 'EG', now());

    u1 := gen_random_uuid(); u2 := gen_random_uuid();
    INSERT INTO units (id, tenant_id, code, building, floor, updated_at) VALUES
      (u1, t, 'A-101', 'A', 1, now()),
      (u2, t, 'A-102', 'A', 1, now());

    INSERT INTO tenant_settings (tenant_id, timezone, updated_at) VALUES (t, 'Africa/Cairo', now());

    -- A night roster at the gate, and slots made from it as before
    -- 20261114090000: the window's length in real time (8 h), the night the
    -- clock goes back (29 → 30 October 2026) and ten nights from now.
    gate := gen_random_uuid(); tpl := gen_random_uuid();
    INSERT INTO gates (id, tenant_id, name, kind, updated_at) VALUES (gate, t, 'Main gate', 'mixed', now());
    INSERT INTO guard_roster_templates (id, tenant_id, guard_account_id, gate_id, schedule, effective_from,
                                        created_by_account_id, updated_at) VALUES
      (tpl, t, guard, gate, '{"days": [0, 1, 2, 3, 4, 5, 6], "windows": [{"from": "22:00", "to": "06:00"}]}',
       current_date, mgr, now());
    FOREACH night IN ARRAY ARRAY[
      timestamp '2026-10-29 22:00' AT TIME ZONE 'Africa/Cairo',
      (current_date + 10 + time '22:00') AT TIME ZONE 'Africa/Cairo'
    ] LOOP
      INSERT INTO guard_roster_slots (id, tenant_id, guard_account_id, gate_id, template_id, starts_at,
                                      ends_at, updated_at)
      VALUES (gen_random_uuid(), t, guard, gate, tpl, night, night + interval '8 hours', now());
    END LOOP;

    INSERT INTO known_devices (id, tenant_id, account_id, device_hash, source, device_type, os, client) VALUES
      (gen_random_uuid(), t, res1, encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'app', 'ios', 'ios', 'app'),
      (gen_random_uuid(), t, res1, encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'web', 'desktop_web', 'linux', 'firefox'),
      (gen_random_uuid(), t, res2, encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'app', 'android', 'android', 'app');

    -- Active (with a code), used (everyone came in), cancelled by the host.
    INSERT INTO visitor_passes (id, tenant_id, unit_id, host_account_id, kind, party_size,
                                valid_from, valid_until, status, code_hash, entries_used,
                                used_at, cancelled_at, cancelled_by, cancel_reason_code) VALUES
      (gen_random_uuid(), t, u1, res1, 'one_time', 2, now() - interval '1 hour', now() + interval '1 day',
       'active', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 0, NULL, NULL, NULL, NULL),
      (gen_random_uuid(), t, u1, res1, 'one_time', 1, now() - interval '3 days', now() - interval '2 days',
       'used', NULL, 1, now() - interval '3 days', NULL, NULL, NULL),
      (gen_random_uuid(), t, u2, res2, 'one_time', 1, now() - interval '2 days', now() + interval '2 days',
       'cancelled', NULL, 0, NULL, now() - interval '1 day', res2, 'plans_changed');

    i_old := gen_random_uuid(); i_sched := gen_random_uuid(); i_told := gen_random_uuid();
    INSERT INTO guard_instructions (id, tenant_id, title, body, audience, created_by_account_id,
                                    created_at, updated_at, valid_from) VALUES
      (i_old, t, 'Seed: before validity', 'Close the side gate at night.', 'all', mgr,
       now() - interval '40 days', now() - interval '40 days', NULL),
      (i_sched, t, 'Seed: scheduled', 'Expect the movers.', 'all', mgr,
       now() - interval '1 day', now() - interval '1 day', current_date + 5),
      (i_told, t, 'Seed: told', 'Check the barrier.', 'all', mgr,
       now() - interval '2 days', now() - interval '2 days', NULL);
    INSERT INTO guard_instruction_recipients (id, tenant_id, instruction_id, account_id, added_via,
                                              added_at, notified_at) VALUES
      (gen_random_uuid(), t, i_old, guard, 'send', now() - interval '40 days', now() - interval '40 days'),
      (gen_random_uuid(), t, i_sched, guard, 'send', now() - interval '1 day', NULL),
      (gen_random_uuid(), t, i_told, guard, 'send', now() - interval '2 days', now() - interval '2 days');

    batch := gen_random_uuid(); inv := gen_random_uuid();
    INSERT INTO invoice_batches (id, tenant_id, target, unit_id, kind, unit_count, issued_on, due_on,
                                 created_by_account_id) VALUES
      (batch, t, 'unit', u1, 'service_charge', 1, current_date - 10, current_date + 20, mgr);
    INSERT INTO invoices (id, tenant_id, number, batch_id, unit_id, kind, total, currency, issued_on,
                          due_on, created_by_account_id) VALUES
      (inv, t, 1, batch, u1, 'service_charge', 1500.00, 'EGP', current_date - 10, current_date + 20, mgr);
    INSERT INTO invoice_lines (id, tenant_id, invoice_id, position, description_en, description_ar, amount) VALUES
      (gen_random_uuid(), t, inv, 1, 'Service charge', 'رسوم الخدمة', 1500.00);

    h := replace(gen_random_uuid()::text, '-', '');
    INSERT INTO finance_payments (id, tenant_id, kind, unit_id, channel, method, amount, currency,
                                  paid_on, receipt_number, receipt_code, recorded_by_account_id) VALUES
      (gen_random_uuid(), t, 'payment', u1, 'office', 'cash', 500.00, 'EGP',
       current_date - 2, 1, substr(h, 1, 22), mgr);

    -- Registrations: one waiting, with what the registrant typed; one
    -- decided, which keeps none of it.
    lp := lpad(c::text, 2, '0');
    INSERT INTO resident_registrations (id, tenant_id, status, full_name, phone, email,
                                        id_document_type, id_document_number, nationality,
                                        birth_date, unit_code, occupancy_type) VALUES
      (gen_random_uuid(), t, 'pending', 'Seed Registrant', '+2010' || lp || '0000005',
       'reg-' || s || '@seed.test', 'national_id', '2900101' || lp || '00051', 'EG',
       DATE '1990-01-01', 'A-102', 'tenant');
    INSERT INTO resident_registrations (id, tenant_id, status, unit_code, occupancy_type,
                                        decided_at, decided_by, decision_reason_code) VALUES
      (gen_random_uuid(), t, 'rejected', 'A-101', 'owner', now() - interval '3 days', mgr, 'other');

    -- Files: an upload not finalized, one finalized and not yet used, and
    -- one attached to a record (no owner once attached).
    INSERT INTO files (id, tenant_id, owner_account_id, purpose, content_type, size_bytes,
                       status, upload_expires_at, finalized_at, attached_at) VALUES
      (gen_random_uuid(), t, res1, 'document', 'application/pdf', 2048,
       'pending', now() + interval '10 minutes', NULL, NULL),
      (gen_random_uuid(), t, res1, 'document', 'image/png', 4096,
       'ready', now() - interval '1 hour', now() - interval '1 hour', NULL),
      (gen_random_uuid(), t, NULL, 'document', 'application/pdf', 8192,
       'ready', now() - interval '2 hours', now() - interval '2 hours', now() - interval '2 hours');

    -- Maintenance: the categories the default asset types join by key
    -- (the second compound has no `general`), and a resident's tickets as
    -- every ticket was before a ticket had an origin.
    cat := gen_random_uuid();
    INSERT INTO ticket_categories (id, tenant_id, key, name_ar, name_en, updated_at) VALUES
      (cat, t, 'plumbing', 'سباكة', 'Plumbing', now()),
      (gen_random_uuid(), t, 'ac', 'تكييف', 'Air conditioning', now()),
      (gen_random_uuid(), t, 'electrical', 'كهرباء', 'Electrical', now());
    IF c = 1 THEN
      INSERT INTO ticket_categories (id, tenant_id, key, name_ar, name_en, updated_at) VALUES
        (gen_random_uuid(), t, 'general', 'عام', 'General', now());
    END IF;
    INSERT INTO tickets (id, tenant_id, number, unit_id, common_area, unit_location, category_id,
                         created_by_account_id, reporter_account_id, priority, description, updated_at) VALUES
      (gen_random_uuid(), t, 1, u1, NULL, 'kitchen', cat, res1, res1, 'normal', 'The kitchen tap drips', now()),
      (gen_random_uuid(), t, 2, NULL, 'Pool', NULL, cat, mgr, res2, 'urgent', 'The pool pump is loud', now());

    -- The register as M1-2 finds it (ADR 0065): the compound's maintenance
    -- settings, which gain the replacement share, and a common area's
    -- document, whose subject CHECK and trigger gain a contract.
    INSERT INTO maintenance_settings (tenant_id, updated_at) VALUES (t, now());
    area := gen_random_uuid();
    INSERT INTO common_areas (id, tenant_id, kind, code, name_ar, name_en, updated_at) VALUES
      (area, t, 'area', 'POOL', 'حمام السباحة', 'Pool', now());
    doc := gen_random_uuid();
    INSERT INTO files (id, tenant_id, owner_account_id, purpose, content_type, size_bytes,
                       status, upload_expires_at, finalized_at, attached_at) VALUES
      (doc, t, NULL, 'asset_document', 'application/pdf', 4096,
       'ready', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day');
    INSERT INTO maintenance_documents (id, tenant_id, common_area_id, file_id, kind, title,
                                       added_by_account_id, added_at) VALUES
      (gen_random_uuid(), t, area, doc, 'plan', 'The pool plant room', mgr, now());

    -- Permits as they were before a move permit had a direction (ADR 0063):
    -- the loaded copy names one only where the column exists. An open
    -- inspection task, made by the management before a resident could ask.
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'unit_permits' AND column_name = 'move_direction') THEN
      INSERT INTO unit_permits (id, tenant_id, number, kind, unit_id, requested_by_account_id, starts_at, ends_at,
                                truck_plate, items_description, move_direction, updated_at) VALUES
        (gen_random_uuid(), t, 1, 'move', u1, res1, now() + interval '2 days', now() + interval '2 days 4 hours',
         'ABC 123', 'Boxes and a sofa', 'in', now());
    ELSE
      INSERT INTO unit_permits (id, tenant_id, number, kind, unit_id, requested_by_account_id, starts_at, ends_at,
                                truck_plate, items_description, updated_at) VALUES
        (gen_random_uuid(), t, 1, 'move', u1, res1, now() + interval '2 days', now() + interval '2 days 4 hours',
         'ABC 123', 'Boxes and a sofa', now());
    END IF;
    wp := gen_random_uuid();
    INSERT INTO unit_permits (id, tenant_id, number, kind, unit_id, requested_by_account_id, starts_at, ends_at,
                              work_type, daily_from, daily_to, contractor_company, description, updated_at) VALUES
      (wp, t, 1, 'works', u2, res2, date_trunc('day', now()) + interval '3 days',
       date_trunc('day', now()) + interval '10 days', 'finishing', 540, 1020, 'Seed Builders', 'Tiling the kitchen', now());
    INSERT INTO guard_tasks (id, tenant_id, kind, unit_id, gate_id, created_by_account_id, updated_at) VALUES
      (gen_random_uuid(), t, 'closed_unit_inspection', u1, gate, mgr, now());
    -- The permits' days off as ADR 0049 kept them, two of them, which ADR
    -- 0084 moves into the holiday calendar as holidays that stop works and
    -- then drops; on the new schema, the calendar's row and a holiday that
    -- does not stop works, and a common area open to use requests with one
    -- pending.
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'permit_settings' AND column_name = 'days_off') THEN
      INSERT INTO permit_settings (tenant_id, days_off, updated_at) VALUES
        (t, ARRAY[current_date + 10, current_date + 20]::date[], now())
        ON CONFLICT (tenant_id) DO UPDATE SET days_off = EXCLUDED.days_off;
    ELSE
      INSERT INTO permit_settings (tenant_id, updated_at) VALUES (t, now())
        ON CONFLICT (tenant_id) DO NOTHING;
      INSERT INTO holiday_calendars (tenant_id) VALUES (t) ON CONFLICT (tenant_id) DO NOTHING;
      INSERT INTO compound_holidays (id, tenant_id, day, name_en, name_ar, stops_works, updated_at) VALUES
        (gen_random_uuid(), t, current_date + 30, 'Seed feast', 'عيد', false, now())
        ON CONFLICT (tenant_id, day) DO NOTHING;
      INSERT INTO space_use_areas (tenant_id, common_area_id, opened_at) VALUES (t, area, now())
        ON CONFLICT DO NOTHING;
      INSERT INTO space_use_requests (id, tenant_id, common_area_id, unit_id, requested_by_account_id,
                                      starts_at, ends_at, purpose, guests, created_at) VALUES
        (gen_random_uuid(), t, area, u1, res1, now() + interval '3 days', now() + interval '3 days 2 hours',
         'A birthday', 10, now());
    END IF;
    -- The bookings, emergencies and incidents as M1-3b finds them (ADR 0067):
    -- a ban's cancel reason and its link join the bookings' CHECKs, a ticket
    -- origin the emergencies' and incidents'.
    fac := gen_random_uuid();
    INSERT INTO facilities (id, tenant_id, mode, name_en, name_ar, slot_minutes, capacity, capacity_unit,
                            max_days_ahead, min_minutes_before, cancel_cutoff_minutes, max_guests,
                            weekly_quota, peak_quota, updated_at) VALUES
      (fac, t, 'bookable', 'Court', 'ملعب', 60, 1, 'bookings', 14, 60, 120, 0, 2, 1, now());
    INSERT INTO bookings (id, tenant_id, facility_id, unit_id, booked_by_account_id, starts_at, ends_at,
                          guests, party_size, peak, status, updated_at) VALUES
      (gen_random_uuid(), t, fac, u1, res1, date_trunc('hour', now()) + interval '2 days',
       date_trunc('hour', now()) + interval '2 days 1 hour', 0, 1, false, 'confirmed', now());
    INSERT INTO bookings (id, tenant_id, facility_id, unit_id, booked_by_account_id, starts_at, ends_at,
                          guests, party_size, peak, status, cancelled_side, cancel_reason,
                          cancelled_by_account_id, cancelled_at, updated_at) VALUES
      (gen_random_uuid(), t, fac, u2, res2, date_trunc('hour', now()) + interval '3 days',
       date_trunc('hour', now()) + interval '3 days 1 hour', 0, 1, false, 'cancelled', 'staff',
       'rules_violation', mgr, now(), now());
    -- What ADR 0070's migrations reach: a staff credit note on the invoice,
    -- a fine paid at the office, a club membership paid at the office.
    INSERT INTO credit_notes (id, tenant_id, number, invoice_id, amount, reason_code,
                              created_by_account_id) VALUES
      (gen_random_uuid(), t, 1, inv, 100.00, 'goodwill', mgr);
    fine := gen_random_uuid();
    INSERT INTO vehicle_fines (id, tenant_id, number, unit_id, plate, reason, amount, occurred_on,
                               issued_by_account_id, status, updated_at) VALUES
      (fine, t, 1, u1, 'ABC123', 'blocking', 300.00, current_date - 5, guard, 'paid', now());
    INSERT INTO vehicle_fine_payments (id, tenant_id, fine_id, kind, amount, currency, receipt_number,
                                       paid_on, recorded_by_account_id) VALUES
      (gen_random_uuid(), t, fine, 'payment', 300.00, 'EGP', 'F-' || s, current_date - 2, mgr);
    plan := gen_random_uuid(); mem := gen_random_uuid();
    INSERT INTO club_plans (id, tenant_id, name_en, name_ar, duration_kind, price, updated_at) VALUES
      (plan, t, 'Monthly', 'شهري', 'monthly', 500.00, now());
    INSERT INTO club_memberships (id, tenant_id, unit_id, created_by_account_id) VALUES
      (mem, t, u1, mgr);
    INSERT INTO club_payment_records (id, tenant_id, membership_id, kind, plan_id, amount, currency,
                                      receipt_number, paid_on, period_starts_on, period_ends_on,
                                      recorded_by_account_id) VALUES
      (gen_random_uuid(), t, mem, 'payment', plan, 500.00, 'EGP', 'C-' || s, current_date - 3,
       current_date - 3, current_date + 27, mgr);
    INSERT INTO emergencies (id, tenant_id, number, unit_id, type, reported_by_account_id,
                             responders_notified, updated_at) VALUES
      (gen_random_uuid(), t, 1, u1, 'medical', res1, 0, now());
    INSERT INTO incidents (id, tenant_id, number, type, severity, unit_id, occurred_at, description,
                           reported_by_account_id, updated_at) VALUES
      (gen_random_uuid(), t, 1, 'hazard', 'low', u1, now() - interval '1 hour', 'A loose tile', mgr, now());
    -- The occupancies, documents and finance rows as R11c-1a finds them
    -- (ADR 0069): `resides_since` is backfilled from each residing row's
    -- start (a converted owner's from its tenant row), a plan gains its
    -- descriptions, the settings their plan, dues and collector terms, and
    -- the document and notice kinds' CHECKs widen. Res1 owns and lives in
    -- A-101 and owns A-102 as a landlord; res2 rented A-102, then bought it.
    occ_t := gen_random_uuid();
    INSERT INTO unit_occupancies (id, tenant_id, unit_id, account_id, occupancy_type, status, is_primary,
                                  started_at, ended_at, created_by, resides, end_reason, primary_since) VALUES
      (gen_random_uuid(), t, u1, res1, 'owner', 'active', true, now() - interval '400 days', NULL, mgr,
       true, NULL, now() - interval '400 days'),
      (gen_random_uuid(), t, u2, res1, 'owner', 'active', false, now() - interval '500 days', NULL, mgr,
       false, NULL, NULL),
      (occ_t, t, u2, res2, 'tenant', 'ended', false, now() - interval '300 days', now() - interval '30 days', mgr,
       true, 'converted_to_owner', NULL);
    INSERT INTO unit_occupancies (id, tenant_id, unit_id, account_id, occupancy_type, status, is_primary,
                                  started_at, created_by, resides, converted_from_id, primary_since) VALUES
      (gen_random_uuid(), t, u2, res2, 'owner', 'active', true, now() - interval '30 days', mgr,
       true, occ_t, now() - interval '30 days');
    INSERT INTO finance_settings (tenant_id, updated_at) VALUES (t, now());
    INSERT INTO billing_plans (id, tenant_id, name_en, name_ar, kind, frequency, amount, starts_on,
                               issue_days_before, due_days_after_issue, created_by_account_id, updated_at) VALUES
      (gen_random_uuid(), t, 'Service charge', 'رسوم الخدمة', 'service_charge', 'monthly', 1500.00,
       date_trunc('month', current_date)::date, 5, 14, mgr, now());
    INSERT INTO invoice_notices (id, tenant_id, invoice_id, kind) VALUES (gen_random_uuid(), t, inv, 'issued');
    INSERT INTO compound_document_versions (id, tenant_id, kind, version_no, title_en, title_ar, body_en, body_ar,
                                            effective_on, published_by, published_at) VALUES
      (gen_random_uuid(), t, 'conduct_guide', 1, 'Conduct', 'السلوك', 'Be kind to your neighbours.',
       'كن لطيفا مع جيرانك.', current_date - 30, mgr, now() - interval '30 days');
    -- The gate's settings and the blocklist as G8 finds them (ADR 0068): the
    -- settings gain the face-check switch (off) and the call times, a match
    -- by ID and one at a visitor pass keep their rows under the widened
    -- CHECKs, and the ban's photo under the files' recreated ones.
    INSERT INTO gate_settings (tenant_id, updated_at) VALUES (t, now());
    ph := gen_random_uuid();
    INSERT INTO files (id, tenant_id, owner_account_id, purpose, content_type, size_bytes,
                       status, upload_expires_at, finalized_at, attached_at) VALUES
      (ph, t, NULL, 'blocklist_photo', 'image/jpeg', 204800,
       'ready', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day');
    bl := gen_random_uuid();
    INSERT INTO blocklist_entries (id, tenant_id, kind, subject, full_name, id_hash, photo_file_id,
                                   reason_code, created_by_account_id, updated_at) VALUES
      (bl, t, 'ban', 'person', 'Seed Banned Person', md5(s) || md5(s || 'id'), ph, 'trespassing', mgr, now());
    SELECT id INTO vp FROM visitor_passes WHERE tenant_id = t ORDER BY id LIMIT 1;
    INSERT INTO blocklist_matches (id, tenant_id, entry_id, kind, source, subject_type, subject_id,
                                   gate_id, actor_account_id, outcome) VALUES
      (gen_random_uuid(), t, bl, 'ban', 'id_lookup', NULL, NULL, gate, guard, 'refused'),
      (gen_random_uuid(), t, bl, 'ban', 'visitor_pass', 'visitor_pass', vp, gate, guard, 'refused');
    IF c = 1 THEN
      INSERT INTO management_request_topics (id, tenant_id, key, name_ar, name_en, target_response_hours, updated_at)
      VALUES (gen_random_uuid(), t, 'utilities', 'المرافق', 'Utilities (ours)', 48, now());
    END IF;
    -- The community as R11c-2 leaves it (ADR 0071): the rows its columns,
    -- backfills and CHECKs reach — passes' notices (a recurring pass is
    -- told of nothing) and expected gate, a standing instruction's opt-in,
    -- a gate's directions and the busy thresholds, an emergency's common
    -- area (a unit's still), the prayer place (both or neither), the
    -- emergency guide kinds, and the conversations' one subject.
    DECLARE
      post uuid := gen_random_uuid();
      lst uuid := gen_random_uuid();
    BEGIN
      INSERT INTO gate_settings (tenant_id, updated_at) VALUES (t, now())
        ON CONFLICT (tenant_id) DO NOTHING;
      UPDATE gate_settings SET gate_busy_normal_from = 5, gate_busy_busy_from = 20 WHERE tenant_id = t;
      UPDATE gates SET directions_en = 'Take the second exit off the ring road.',
                       directions_ar = 'خد المخرج التاني من الطريق الدائري.'
        WHERE id = gate;
      INSERT INTO visitor_passes (id, tenant_id, unit_id, host_account_id, kind, party_size,
                                  valid_from, valid_until, schedule, status, code_hash, entries_used,
                                  notify_on_entry, expected_gate_id) VALUES
        (gen_random_uuid(), t, u1, res1, 'recurring', 1, now() - interval '1 day', now() + interval '20 days',
         '{"days": [1, 4], "windows": [{"from": "08:00", "to": "12:00"}]}'::jsonb, 'active',
         encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 0, false, gate);
      INSERT INTO unit_standing_instructions (id, tenant_id, unit_id, description, action, notify, created_by) VALUES
        (gen_random_uuid(), t, u1, 'The gardener on Mondays', 'always_allow', true, res1),
        (gen_random_uuid(), t, u1, 'The water delivery', 'leave_at_gate', false, res1);
      INSERT INTO emergencies (id, tenant_id, number, unit_id, common_area_id, type, reported_by_account_id,
                               responders_notified, updated_at) VALUES
        (gen_random_uuid(), t, 2, u1, area, 'fire', res1, 0, now());
      INSERT INTO engagement_settings (tenant_id, latitude, longitude, updated_at) VALUES
        (t, 30.044420, 31.235712, now());
      INSERT INTO compound_document_versions (id, tenant_id, kind, version_no, title_en, title_ar, body_en, body_ar,
                                              effective_on, published_by, published_at) VALUES
        (gen_random_uuid(), t, 'emergency_fire', 1, 'Fire', 'الحريق', 'Leave by the stairs, then call the gate.',
         'انزل على السلم وكلم البوابة.', current_date - 7, mgr, now() - interval '7 days');
      INSERT INTO bookings (id, tenant_id, facility_id, unit_id, booked_by_account_id, starts_at, ends_at,
                            guests, party_size, peak, status, updated_at) VALUES
        (gen_random_uuid(), t, fac, u2, res2, date_trunc('hour', now()),
         date_trunc('hour', now()) + interval '1 hour', 0, 1, false, 'confirmed', now());
      INSERT INTO neighbour_posts (id, tenant_id, kind, author_account_id, author_side, author_unit_id, body,
                                   expires_at, updated_at) VALUES
        (post, t, 'lend', res1, 'resident', u1, 'A ladder to lend for the weekend.', now() + interval '14 days', now());
      INSERT INTO market_listings (id, tenant_id, kind, category, seller_account_id, seller_unit_id, title, body,
                                   price, status, expires_at, decided_at, decided_by, updated_at) VALUES
        (lst, t, 'sell', 'furniture', res1, u1, 'Oak dining table', 'Seats six, collect from the lobby.',
         1500.00, 'live', now() + interval '30 days', now(), mgr, now());
      INSERT INTO neighbour_conversations (id, tenant_id, post_id, listing_id, author_account_id,
                                           responder_account_id, responder_unit_id, last_message_at, updated_at) VALUES
        (gen_random_uuid(), t, post, NULL, res1, res2, u2, now(), now()),
        (gen_random_uuid(), t, NULL, lst, res1, res2, u2, now(), now());
      -- The inbox, the authority and the deputy (ADR 0073).
      INSERT INTO governance_approval_settings (tenant_id, type, deadline_days, threshold, binding) VALUES
        (t, 'major_contract', 14, 50000.00, true),
        (t, 'waiver_above_limit', 14, 1000.00, true),
        (t, 'payment_plan_above_limit', 14, NULL, false);
      INSERT INTO staff_inbox_due_hours (tenant_id, type, hours) VALUES (t, 'vehicle', 12);
      INSERT INTO account_deputies (id, tenant_id, principal_account_id, deputy_account_id, permissions,
                                    starts_at, ends_at, created_by_account_id) VALUES
        (gen_random_uuid(), t, mgr, guard, ARRAY['permits.manage'], now(), now() + interval '3 days', mgr);
      UPDATE accounts SET deputy_until = now() + interval '3 days' WHERE id IN (mgr, guard);
      INSERT INTO audit_log (id, tenant_id, actor_type, actor_id, action, target_type, target_id,
                             on_behalf_of_id) VALUES
        (gen_random_uuid(), t, 'account', guard, 'unit_permit.approved', 'unit_permit', gen_random_uuid(), mgr);
    END;

    -- The unit register as M2-1 leaves it (ADR 0072): a building added
    -- ahead of its units, a unit put in it by id (the trigger names it), a
    -- unit named by text alone (the trigger finds or adds its building),
    -- and a valid units import on its kept sheet.
    DECLARE
      bld uuid := gen_random_uuid();
      sheet uuid := gen_random_uuid();
    BEGIN
      INSERT INTO buildings (id, tenant_id, name) VALUES (bld, t, 'Tower ' || s);
      INSERT INTO units (id, tenant_id, code, building_id, floor, unit_type, area_sqm, updated_at) VALUES
        (gen_random_uuid(), t, 'T-' || s, bld, 4, 'apartment', 120.50, now());
      INSERT INTO units (id, tenant_id, code, building, updated_at) VALUES
        (gen_random_uuid(), t, 'C-' || s, 'Court ' || s, now());
      INSERT INTO files (id, tenant_id, owner_account_id, purpose, content_type, size_bytes,
                         status, upload_expires_at, finalized_at, attached_at) VALUES
        (sheet, t, NULL, 'data_import', 'text/csv', 64,
         'ready', now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour');
      INSERT INTO unit_imports (id, tenant_id, kind, file_id, status, row_count, error_count,
                                created_by_account_id, created_at) VALUES
        (gen_random_uuid(), t, 'units', sheet, 'valid', 1, 0, mgr, now());
    END;
    DECLARE
      atype uuid := gen_random_uuid();
      pump uuid := gen_random_uuid();
      wo uuid := gen_random_uuid();
    BEGIN
      INSERT INTO maintenance_sla_settings (tenant_id, sla_enabled, enabled_at, at_risk_percent_urgent,
                                            updated_at) VALUES
        (t, true, now() - interval '1 day', NULL, now())
        ON CONFLICT (tenant_id) DO NOTHING;
      INSERT INTO asset_types (id, tenant_id, key, name_ar, name_en, category_id, updated_at) VALUES
        (atype, t, 'seed_pump', 'مضخة', 'Pump', cat, now());
      INSERT INTO assets (id, tenant_id, code, type_id, depth, common_area_id, name_ar, name_en,
                          warranty_starts_on, warranty_ends_on, warrantor, warranty_covers, updated_at) VALUES
        (pump, t, 'SEED-PUMP', atype, 1, area, 'مضخة', 'Pool pump',
         current_date - 30, current_date + 335, 'Pumps & Co', 'Motor and seals', now());
      INSERT INTO tickets (id, tenant_id, number, common_area, common_area_id, category_id,
                           created_by_account_id, reporter_account_id, priority, description,
                           origin, asset_id, updated_at) VALUES
        (wo, t, 3, 'Pool', area, cat, mgr, mgr, 'normal', 'The pump hums', 'staff', pump, now());
      INSERT INTO warranty_claims (id, tenant_id, asset_id, ticket_id, description, opened_by_account_id,
                                   opened_at) VALUES
        (gen_random_uuid(), t, pump, wo, 'The seal failed within the warranty', mgr, now());
      INSERT INTO tickets (id, tenant_id, number, common_area, common_area_id, category_id,
                           created_by_account_id, reporter_account_id, priority, description,
                           origin, asset_id, created_at, updated_at) VALUES
        (gen_random_uuid(), t, 5, 'Pool', area, cat, mgr, mgr, 'normal', 'The pump hums again', 'staff', pump,
         now() - interval '20 days', now()),
        (gen_random_uuid(), t, 6, 'Pool', area, cat, mgr, mgr, 'normal', 'The pump stopped', 'staff', pump,
         now() - interval '5 days', now());
    END;
    DECLARE
      tower uuid := gen_random_uuid();
      ua uuid := gen_random_uuid();
      ub uuid := gen_random_uuid();
    BEGIN
      INSERT INTO buildings (id, tenant_id, name) VALUES (tower, t, 'Analytics ' || s);
      INSERT INTO units (id, tenant_id, code, building_id, updated_at) VALUES
        (ua, t, 'AN-A-' || s, tower, now()),
        (ub, t, 'AN-B-' || s, tower, now());
      INSERT INTO tickets (id, tenant_id, number, unit_id, category_id, created_by_account_id,
                           reporter_account_id, priority, description, created_at, updated_at) VALUES
        (gen_random_uuid(), t, 7, ua, cat, mgr, mgr, 'normal', 'Low pressure', now() - interval '3 days', now()),
        (gen_random_uuid(), t, 8, ub, cat, mgr, mgr, 'normal', 'Low pressure too', now() - interval '1 day', now());
    END;
    -- ADR 0077: a vendor of the register, a contract naming it with its
    -- terms and a payment schedule (one paid), and a purchase request.
    DECLARE
      ven uuid := gen_random_uuid();
      con uuid := gen_random_uuid();
    BEGIN
      INSERT INTO vendors (id, tenant_id, number, name, categories, phone, updated_at) VALUES
        (ven, t, 1, 'Seed Lifts ' || left(gen_random_uuid()::text, 8), ARRAY['maintenance'], '+20 2 1234 5678', now());
      INSERT INTO procurement_counters (tenant_id, kind, last_number) VALUES (t, 'vendor', 1), (t, 'purchase_request', 1)
        ON CONFLICT (tenant_id, kind) DO NOTHING;
      INSERT INTO maintenance_contracts (id, tenant_id, code, kind, vendor_id, vendor_name, starts_on, ends_on,
                                         annual_value, late_penalty_per_day, penalty_cap, response_hours,
                                         auto_renews, renewal_term_months, updated_at) VALUES
        (con, t, 'SEED-' || left(gen_random_uuid()::text, 8), 'cleaning', ven, 'Seed Lifts',
         current_date - 30, current_date + 300, 12000.00, 250.00, 5000.00, 4, true, 12, now());
      INSERT INTO maintenance_contract_payments (id, tenant_id, contract_id, due_on, amount, paid_on,
                                                 paid_by_account_id, paid_at, created_by_account_id, created_at) VALUES
        (gen_random_uuid(), t, con, current_date - 10, 1000.00, current_date - 9, mgr, now(), mgr, now()),
        (gen_random_uuid(), t, con, current_date + 20, 1000.00, NULL, NULL, NULL, mgr, now());
      INSERT INTO purchase_requests (id, tenant_id, number, title, vendor_id, estimated_amount,
                                     requested_by_account_id, requested_at, updated_at) VALUES
        (gen_random_uuid(), t, 1, 'Two pump seals', ven, 3500.00, mgr, now(), now());
      -- ADR 0087: a compliance item answered for by that vendor and the
      -- manager, done once with its next due day open.
      DECLARE
        itm uuid := gen_random_uuid();
        occ uuid := gen_random_uuid();
      BEGIN
        INSERT INTO compliance_items (id, tenant_id, kind, title, vendor_id, owner_account_id,
                                      recurrence_months, created_by_account_id) VALUES
          (itm, t, 'lift', 'Lift licence', ven, mgr, 12, mgr);
        INSERT INTO compliance_occurrences (id, tenant_id, item_id, due_on, status, done_on, done_at,
                                            done_by_account_id, expires_on) VALUES
          (occ, t, itm, current_date - 5, 'done', current_date - 6, now(), mgr, current_date + 360);
        INSERT INTO compliance_occurrences (id, tenant_id, item_id, due_on, previous_id) VALUES
          (gen_random_uuid(), t, itm, current_date + 360, occ);
      END;
    END;
    -- ADR 0087: a drill done with its outcome, and a lockdown the management
    -- started from the office, ended.
    DECLARE
      prog uuid := gen_random_uuid();
    BEGIN
      INSERT INTO readiness_programs (id, tenant_id, kind, title, starts_on, ends_on, updated_at) VALUES
        (prog, t, 'emergency', 'Fire readiness', current_date - 10, current_date + 20, now());
      INSERT INTO readiness_items (id, tenant_id, program_id, kind, title, owner_account_id, due_on,
                                   drill_type, drill_outcome, drill_participants, drill_minutes,
                                   done_at, done_by_account_id, updated_at) VALUES
        (gen_random_uuid(), t, prog, 'drill', 'Evacuation drill', mgr, current_date - 2,
         'evacuation', 'passed', 40, 8, now(), mgr, now());
      INSERT INTO gate_lockdowns (id, tenant_id, gate_id, reason_code, started_by_account_id, started_shift_id,
                                  started_from, started_at, ended_at, ended_by_account_id, end_reason,
                                  updated_at) VALUES
        (gen_random_uuid(), t, NULL, 'drill', mgr, NULL, 'office', now() - interval '2 hours',
         now() - interval '1 hour', mgr, 'drill_over', now());
    END;
    -- An inspection request whose task went with its guard (`assignee_left`)
    -- and that stayed scheduled: 20270511090000 cancels it with its task.
    DECLARE
      req uuid := gen_random_uuid();
    BEGIN
      INSERT INTO unit_inspection_requests (id, tenant_id, number, unit_id, requested_by, preferred_on,
                                            status, created_at, scheduled_at) VALUES
        (req, t, 1, u2, res2, current_date + 3, 'scheduled', now() - interval '2 days',
         now() - interval '1 day');
      INSERT INTO guard_tasks (id, tenant_id, kind, unit_id, assignee_account_id, created_by_account_id,
                               status, cancelled_at, cancel_reason, request_id, updated_at) VALUES
        (gen_random_uuid(), t, 'closed_unit_inspection', u2, guard, mgr, 'cancelled', now(), 'assignee_left',
         req, now());
    END;
    -- Fit-out completion (ADR 0074): the rows its columns and CHECKs reach —
    -- the compound's permit rules as the app provisions them (a later
    -- migration finds a compound's row there, as 20270209090200 finds the
    -- existing ones and writes the deposit rule off for them), a
    -- finishing-works deposit naming the pending works permit (its kind and
    -- its unit's keys) and a move deposit naming none. The fit-out's own
    -- tables are new: nothing here to carry.
    INSERT INTO permit_settings (tenant_id, updated_at) VALUES (t, now())
      ON CONFLICT (tenant_id) DO NOTHING;
    INSERT INTO finance_deposits (id, tenant_id, number, unit_id, occupancy_id, kind, amount, received_on, method,
                                  recorded_by, created_at, permit_id, permit_kind)
      SELECT gen_random_uuid(), t, 1, u2, o.id, 'finishing_works', 5000.00, current_date, 'cash', mgr, now(),
             wp, 'works'
        FROM unit_occupancies o
       WHERE o.unit_id = u2 AND o.account_id = res2 AND o.status = 'active';
    INSERT INTO finance_deposits (id, tenant_id, number, unit_id, occupancy_id, kind, amount, received_on, method,
                                  recorded_by, created_at)
      SELECT gen_random_uuid(), t, 2, u2, o.id, 'move', 1000.00, current_date, 'bank_transfer', mgr, now()
        FROM unit_occupancies o
       WHERE o.unit_id = u2 AND o.account_id = res2 AND o.status = 'active';
    -- The office queue as M2-9 leaves it (ADR 0080): an announcement put to
    -- one unit and reminded once, a template of each kind, a conversation
    -- the management started, a request closed as converted into its ticket
    -- (the on-behalf and closed-shape CHECKs recreated), a deferred
    -- suggestion with its answer, and an official letter with its pointer.
    DECLARE
      ann uuid := gen_random_uuid();
      topic uuid := gen_random_uuid();
      stopic uuid := gen_random_uuid();
      tk uuid := gen_random_uuid();
      letter uuid := gen_random_uuid();
      code text := substr(md5(s || 'letter'), 1, 22);
    BEGIN
      INSERT INTO announcements (id, tenant_id, kind, priority, publish_at, audience_occupancy, audience_units,
                                 notified_at, reminded_at, created_by_account_id, updated_at) VALUES
        (ann, t, 'general', 'important', now() - interval '2 days', 'everyone', ARRAY[u1],
         now() - interval '2 days', now() - interval '1 day', mgr, now());
      INSERT INTO announcement_versions (id, tenant_id, announcement_id, version, title_en, body_en,
                                         edited_by_account_id) VALUES
        (gen_random_uuid(), t, ann, 1, 'Water cut', 'The water is off on Sunday morning.', mgr);
      INSERT INTO announcement_templates (id, tenant_id, name, title_en, body_en, created_by_account_id,
                                          updated_at) VALUES
        (gen_random_uuid(), t, 'Water cut', 'Water cut', 'The water is off on [day].', mgr, now());
      INSERT INTO management_request_topics (id, tenant_id, key, name_ar, name_en, target_response_hours, updated_at)
      VALUES (topic, t, 'seed_letters', 'خطابات', 'Letters', 72, now());
      INSERT INTO request_reply_templates (id, tenant_id, topic_id, name, body_en, created_by_account_id,
                                           updated_at) VALUES
        (gen_random_uuid(), t, topic, 'Letter ready', 'Your letter is ready at the office.', mgr, now());
      INSERT INTO tickets (id, tenant_id, number, unit_id, category_id, created_by_account_id,
                           reporter_account_id, priority, description, updated_at) VALUES
        (tk, t, 4, u1, cat, mgr, res1, 'normal', 'The balcony door sticks', now());
      INSERT INTO management_requests (id, tenant_id, number, type, topic_id, author_account_id,
                                       opened_by_account_id, unit_id, status, cycle_started_at, response_due_at,
                                       first_response_at, answered_at, last_activity_at, outreach, updated_at) VALUES
        (gen_random_uuid(), t, 901, 'general', topic, res1, mgr, u1, 'answered', now() - interval '1 day',
         now() + interval '2 days', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day',
         true, now());
      INSERT INTO management_requests (id, tenant_id, number, type, topic_id, author_account_id, unit_id,
                                       status, cycle_started_at, response_due_at, last_activity_at, closed_at,
                                       close_reason, closed_by_side, converted_ticket_id, updated_at) VALUES
        (gen_random_uuid(), t, 902, 'general', topic, res1, u1, 'closed', now() - interval '3 days',
         now(), now() - interval '2 days', now() - interval '2 days', 'converted', 'staff', tk, now());
      INSERT INTO suggestion_topics (id, tenant_id, key, name_ar, name_en, updated_at) VALUES
        (stopic, t, 'seed_ideas', 'أفكار', 'Ideas', now());
      INSERT INTO suggestions (id, tenant_id, author_account_id, topic_id, body, status, response,
                               responded_at, updated_at) VALUES
        (gen_random_uuid(), t, res1, stopic, 'A bench by the pool.', 'deferred',
         'Next year, with the pool works.', now(), now());
      INSERT INTO official_letters (id, tenant_id, number, kind, unit_id, account_id, subject_name,
                                    occupancy_type, occupancy_since, addressee, issued_by_account_id,
                                    issued_at, verify_code, template) VALUES
        (letter, t, 1, 'residence_confirmation', u1, res1, 'Seed Resident One', 'owner',
         current_date - 400, 'The bank', mgr, now(), code, 'certificate.v2');
      INSERT INTO official_letter_counters (tenant_id, last_number) VALUES (t, 1);
      INSERT INTO official_letter_links (code_hash, tenant_id, letter_id, created_at) VALUES
        (encode(sha256(convert_to(code, 'UTF8')), 'hex'), t, letter, now());
    END;
    -- Experience and recovery (ADR 0082): a ticket confirmed low with its
    -- reason, a management request rated 1 with its reason, the compensation
    -- threshold (binding), a rule off, a follow-up a signal opened with an
    -- approved credit on the unit's invoice, and a measured promise.
    DECLARE
      topic uuid := gen_random_uuid();
      req uuid := gen_random_uuid();
      ec uuid := gen_random_uuid();
      cn uuid := gen_random_uuid();
    BEGIN
      INSERT INTO ticket_feedback (id, tenant_id, ticket_id, cycle, kind, author_account_id, rating,
                                   low_reason_code) VALUES
        (gen_random_uuid(), t, (SELECT id FROM tickets WHERE tenant_id = t AND number = 1), 1,
         'confirmed', res1, 2, 'slow');
      INSERT INTO management_request_topics (id, tenant_id, key, name_ar, name_en, target_response_hours,
                                             updated_at) VALUES
        (topic, t, 'seed_experience', 'تجربة', 'Experience', 24, now());
      INSERT INTO management_requests (id, tenant_id, number, type, topic_id, author_account_id, unit_id,
                                       cycle_started_at, response_due_at, last_activity_at, updated_at) VALUES
        (req, t, 900, 'question', topic, res1, u1, now(), now() + interval '24 hours', now(), now());
      INSERT INTO management_request_ratings (tenant_id, request_id, author_account_id, rating,
                                              low_reason_code) VALUES
        (t, req, res1, 1, 'poor_communication');
      INSERT INTO governance_approval_settings (tenant_id, type, deadline_days, threshold, binding) VALUES
        (t, 'compensation_above_limit', 14, 500.00, true)
        ON CONFLICT (tenant_id, type) DO UPDATE SET threshold = 500.00, binding = true;
      INSERT INTO experience_settings (tenant_id, complaints_count) VALUES (t, NULL);
      INSERT INTO experience_cases (id, tenant_id, number, unit_id, kind, origin, opened_at) VALUES
        (ec, t, 1, u1, 'follow_up', 'signal', now());
      INSERT INTO experience_signals (id, tenant_id, unit_id, code, basis_id, count, window_days,
                                      detected_at, case_id) VALUES
        (gen_random_uuid(), t, u1, 'repeated_low_ratings', req, 2, 90, now(), ec);
      INSERT INTO credit_notes (id, tenant_id, number, invoice_id, amount, reason_code, compensation_reason,
                                created_by_account_id) VALUES
        (cn, t, 2, inv, 50.00, 'compensation', 'maintenance_delay', mgr);
      INSERT INTO experience_compensations (id, tenant_id, case_id, unit_id, kind, failure_code, amount,
                                            status, proposed_by_account_id, proposed_at,
                                            decided_by_account_id, decided_at, credit_note_id) VALUES
        (gen_random_uuid(), t, ec, u1, 'credit', 'maintenance_delay', 50.00, 'approved', mgr, now(),
         mgr, now(), cn);
      INSERT INTO service_promises (id, tenant_id, title_en, title_ar, metric, target, created_by_account_id,
                                    created_at, updated_at) VALUES
        (gen_random_uuid(), t, 'Requests rated 4 or better', 'تقييم 4 فأكثر', 'request_rating', 4, mgr,
         now(), now());
    END;
    -- The board's work (ADR 0075): a sitting board, its handover pack, a
    -- meeting held with its attendance, agenda and an open action, a
    -- unit's share, the rules, a manager's delivered handover and a month's
    -- report.
    DECLARE
      term uuid := gen_random_uuid();
      seat uuid := gen_random_uuid();
      mtg uuid := gen_random_uuid();
    BEGIN
      INSERT INTO board_terms (id, tenant_id, source, seats, starts_at, ends_at, created_by_account_id, created_at) VALUES
        (term, t, 'appointed', 3, now() - interval '30 days', now() + interval '300 days', mgr, now() - interval '30 days');
      INSERT INTO board_members (id, tenant_id, term_id, account_id, role, added_at, added_by_account_id) VALUES
        (seat, t, term, res1, 'chair', now() - interval '30 days', mgr);
      INSERT INTO board_handover_packs (id, tenant_id, term_id, contents, generated_at) VALUES
        (gen_random_uuid(), t, term, '{"asOf": "2027-01-01", "approvals": {"pending": []}}'::jsonb, now() - interval '30 days');
      INSERT INTO board_meetings (id, tenant_id, term_id, number, kind, title, location, scheduled_at, status,
                                  held_at, seated_count, present_count, quorate, author_side,
                                  created_by_account_id, created_at, updated_at) VALUES
        (mtg, t, term, 1, 'regular', 'The first meeting', 'The club house', now() - interval '2 days', 'scheduled',
         NULL, NULL, NULL, NULL, 'board', res1, now() - interval '3 days', now());
      INSERT INTO board_meeting_agenda_items (tenant_id, meeting_id, position, kind, title) VALUES
        (t, mtg, 1, 'other', 'The gardener''s contract');
      UPDATE board_meetings SET status = 'held', held_at = now() - interval '2 days', seated_count = 1,
                                present_count = 1, quorate = true
        WHERE id = mtg;
      INSERT INTO board_meeting_attendance (tenant_id, meeting_id, member_id, present) VALUES (t, mtg, seat, true);
      INSERT INTO board_meeting_actions (id, tenant_id, meeting_id, title, owner_account_id, due_on,
                                         created_by_account_id, created_at) VALUES
        (gen_random_uuid(), t, mtg, 'Ask three firms for a quote', res1, current_date + 14, res1, now() - interval '2 days');
      INSERT INTO governance_unit_shares (tenant_id, unit_id, share, updated_by_account_id, updated_at) VALUES
        (t, u1, 2.5000, mgr, now());
      INSERT INTO governance_rules (tenant_id, candidacy_no_dues, candidacy_not_staff, board_report_monthly,
                                    updated_by_account_id, updated_at) VALUES
        (t, true, false, true, mgr, now());
      INSERT INTO manager_handovers (id, tenant_id, account_id, status, notes, contents, created_at, updated_at,
                                     delivered_at) VALUES
        (gen_random_uuid(), t, mgr, 'delivered', 'The pool pump needs a seal.', '{"asOf": "2027-01-01"}'::jsonb,
         now() - interval '1 day', now(), now());
      INSERT INTO board_reports (id, tenant_id, period, version, contents, generated_at) VALUES
        (gen_random_uuid(), t, date_trunc('month', current_date)::date, 1, '{"month": "2027-01"}'::jsonb, now());
    END;
    DECLARE
      offer uuid := gen_random_uuid();
      owner_occ uuid;
    BEGIN
      INSERT INTO group_offers (id, tenant_id, title_en, title_ar, body_en, body_ar, list_price,
                                group_price, min_participants, closes_at, status, created_by,
                                closed_at, updated_at) VALUES
        (offer, t, 'Seed filters', 'فلاتر', 'One a home.', 'لكل وحدة.', 1200, 950, 2,
         now() - interval '1 day', 'confirmed', mgr, now() - interval '1 day', now());
      INSERT INTO group_offer_participants (id, tenant_id, offer_id, account_id, unit_id, kind,
                                            quantity, joined_at) VALUES
        (gen_random_uuid(), t, offer, res1, u1, 'join', 1, now() - interval '3 days');
      SELECT id INTO owner_occ FROM unit_occupancies
       WHERE tenant_id = t AND unit_id = u1 AND account_id = res1 AND status = 'active';
      INSERT INTO unit_proxies (id, tenant_id, unit_id, appointed_by_occupancy_id, created_by,
                                created_at, scopes, expires_at, status, invite_expires_at,
                                ended_at, end_reason, ended_by) VALUES
        (gen_random_uuid(), t, u1, owner_occ, res1, now() - interval '10 days', ARRAY['inspections'],
         now() + interval '50 days', 'ended', now() - interval '3 days',
         now() - interval '5 days', 'revoked', res1);
    END;
    -- ADR 0089: a terminated contract holding a retention share (its
    -- trigger is recreated whole), the variance setting, the expense
    -- counter and a purchase request's overdue mark (the counters' and the
    -- inbox's CHECKs are widened).
    DECLARE
      ven2 uuid := gen_random_uuid();
    BEGIN
      INSERT INTO vendors (id, tenant_id, number, name, categories, updated_at) VALUES
        (ven2, t, 2, 'Seed Gardens ' || left(gen_random_uuid()::text, 8), ARRAY['landscaping'], now());
      INSERT INTO maintenance_contracts (id, tenant_id, code, kind, vendor_id, vendor_name, starts_on, ends_on,
                                         annual_value, retention_pct, terminated_at, terminated_by_account_id,
                                         termination_reason, updated_at) VALUES
        (gen_random_uuid(), t, 'SEED-' || left(gen_random_uuid()::text, 8), 'landscaping', ven2, 'Seed Gardens',
         current_date - 300, current_date - 1, 6000.00, 5.00, now(), mgr, 'not_needed', now());
      UPDATE finance_settings SET variance_reason_pct = 15 WHERE tenant_id = t;
      INSERT INTO finance_counters (tenant_id, kind, last_number) VALUES (t, 'vendor_invoice', 1)
        ON CONFLICT (tenant_id, kind) DO NOTHING;
      INSERT INTO staff_inbox_overdue (tenant_id, type, item_id, notified_at) VALUES
        (t, 'purchase_request', gen_random_uuid(), now());
    END;
  END LOOP;
END $$;
