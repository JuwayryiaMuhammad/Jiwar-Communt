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
-- (the first compound) a `utilities` topic of the management's own.
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
    INSERT INTO unit_permits (id, tenant_id, number, kind, unit_id, requested_by_account_id, starts_at, ends_at,
                              work_type, daily_from, daily_to, contractor_company, description, updated_at) VALUES
      (gen_random_uuid(), t, 1, 'works', u2, res2, date_trunc('day', now()) + interval '3 days',
       date_trunc('day', now()) + interval '10 days', 'finishing', 540, 1020, 'Seed Builders', 'Tiling the kitchen', now());
    INSERT INTO guard_tasks (id, tenant_id, kind, unit_id, gate_id, created_by_account_id, updated_at) VALUES
      (gen_random_uuid(), t, 'closed_unit_inspection', u1, gate, mgr, now());
    IF c = 1 THEN
      INSERT INTO management_request_topics (id, tenant_id, key, name_ar, name_en, target_response_hours, updated_at)
      VALUES (gen_random_uuid(), t, 'utilities', 'المرافق', 'Utilities (ours)', 48, now());
    END IF;
  END LOOP;
END $$;
