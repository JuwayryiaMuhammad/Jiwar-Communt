-- ============================================================================
-- Phase P1 — requests to partners (ADR 0060). A resident asks a partner for
-- a service at a unit in a time window; the partner answers on its desk (a
-- page its link opens, no account) or through the management's relay:
-- accept, decline, propose another window, mark done. A request keeps what
-- it asked and moves forward only; its history is append-only. The desk
-- link is a global pointer, read before any compound is known.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The compound's counter: a request's number (SR-000123), taken last in the
-- transaction under the row's lock, like a ticket's.
-- ----------------------------------------------------------------------------
CREATE TABLE "partner_request_counters" (
    "tenant_id" UUID NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "partner_request_counters_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "partner_request_counters" ADD CONSTRAINT "partner_request_counters_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ----------------------------------------------------------------------------
-- The request. LIVE = pending, proposed, accepted. What it asked never
-- changes (trigger): partner, unit, requester, category, the window asked,
-- whether the partner's staff get a gate pass. The window the partner
-- proposed (and how many of its staff would come) lives while it is
-- proposed; the agreed one, and the staff count, from acceptance on.
-- A closed request keeps how it closed. The note is the requester's words:
-- an erasure clears it, once.
-- ----------------------------------------------------------------------------
CREATE TABLE "partner_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "partner_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "requester_account_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "subcategory_id" UUID,
    "asked_starts_at" TIMESTAMPTZ(3) NOT NULL,
    "asked_ends_at" TIMESTAMPTZ(3) NOT NULL,
    "note" TEXT,
    "note_cleared_at" TIMESTAMPTZ(3),
    "gate_pass" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "proposed_starts_at" TIMESTAMPTZ(3),
    "proposed_ends_at" TIMESTAMPTZ(3),
    "agreed_starts_at" TIMESTAMPTZ(3),
    "agreed_ends_at" TIMESTAMPTZ(3),
    "staff_count" INTEGER,
    "accepted_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "closed_by" TEXT,
    "close_reason" TEXT,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "partner_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "partner_requests_tenant_id_id_key" ON "partner_requests"("tenant_id", "id");
CREATE UNIQUE INDEX "partner_requests_number_key" ON "partner_requests"("tenant_id", "number");
CREATE INDEX "partner_requests_requester_idx"
  ON "partner_requests"("tenant_id", "requester_account_id", "last_activity_at" DESC, "id");
CREATE INDEX "partner_requests_partner_idx"
  ON "partner_requests"("tenant_id", "partner_id", "status", "asked_starts_at");
CREATE INDEX "partner_requests_queue_idx"
  ON "partner_requests"("tenant_id", "created_at" DESC, "id");
CREATE INDEX "partner_requests_live_idx"
  ON "partner_requests"("tenant_id", "status", "asked_starts_at")
  WHERE "status" IN ('pending', 'proposed', 'accepted');
ALTER TABLE "partner_requests"
  ADD CONSTRAINT "partner_requests_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "partner_requests_tenant_id_partner_id_fkey"
  FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partners"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "partner_requests_tenant_id_unit_id_fkey"
  FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "units"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "partner_requests_tenant_id_requester_fkey"
  FOREIGN KEY ("tenant_id", "requester_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "partner_requests_subcategory_fkey"
  FOREIGN KEY ("tenant_id", "subcategory_id", "category")
  REFERENCES "partner_subcategories"("tenant_id", "id", "category")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_number_positive"
  CHECK ("number" >= 1);
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_category"
  CHECK ("category" IN ('gas_water', 'pharmacy', 'grocery', 'home_services', 'laundry',
    'gardening', 'beauty_at_home', 'repair', 'pets', 'events', 'moving_storage',
    'car_services', 'elderly_care'));
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_status"
  CHECK ("status" IN ('pending', 'proposed', 'accepted', 'declined', 'cancelled',
    'expired', 'done', 'partner_no_show', 'lapsed'));
-- Every window lasts more than nothing and at most eight hours.
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_windows"
  CHECK ("asked_ends_at" > "asked_starts_at"
     AND "asked_ends_at" <= "asked_starts_at" + interval '8 hours'
     AND ("proposed_starts_at" IS NULL
          OR ("proposed_ends_at" > "proposed_starts_at"
              AND "proposed_ends_at" <= "proposed_starts_at" + interval '8 hours'))
     AND ("agreed_starts_at" IS NULL
          OR ("agreed_ends_at" > "agreed_starts_at"
              AND "agreed_ends_at" <= "agreed_starts_at" + interval '8 hours')));
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_note_length"
  CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500);
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_note_cleared"
  CHECK ("note_cleared_at" IS NULL OR "note" IS NULL);
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_staff_count"
  CHECK ("staff_count" IS NULL OR "staff_count" BETWEEN 1 AND 5);
-- Each status sets exactly its columns. Nullable columns appear only under
-- IS [NOT] NULL; status is NOT NULL.
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_state_shape"
  CHECK (("proposed_starts_at" IS NULL) = ("proposed_ends_at" IS NULL)
     AND ("status" = 'proposed') = ("proposed_starts_at" IS NOT NULL)
     AND ("agreed_starts_at" IS NULL) = ("agreed_ends_at" IS NULL)
     AND ("agreed_starts_at" IS NULL) = ("accepted_at" IS NULL)
     AND ("staff_count" IS NOT NULL) = ("status" = 'proposed' OR "accepted_at" IS NOT NULL)
     AND ("status" NOT IN ('accepted', 'done', 'partner_no_show', 'lapsed') OR "accepted_at" IS NOT NULL)
     AND ("status" NOT IN ('pending', 'proposed', 'declined', 'expired') OR "accepted_at" IS NULL)
     AND ("closed_at" IS NULL) = ("status" IN ('pending', 'proposed', 'accepted'))
     AND ("closed_by" IS NULL) = ("closed_at" IS NULL)
     AND ("close_reason" IS NULL OR "status" IN ('declined', 'cancelled'))
     AND ("status" NOT IN ('declined', 'cancelled') OR "close_reason" IS NOT NULL));
-- Who closes what: the partner declines; the system expires and lapses;
-- either side marks done; the resident says the partner did not come.
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_closed_by"
  CHECK ("closed_by" IS NULL
      OR ("status" = 'declined' AND "closed_by" = 'partner')
      OR ("status" IN ('expired', 'lapsed') AND "closed_by" = 'system')
      OR ("status" = 'done' AND "closed_by" IN ('resident', 'partner'))
      OR ("status" = 'partner_no_show' AND "closed_by" = 'resident')
      OR ("status" = 'cancelled' AND "closed_by" IN ('resident', 'partner', 'system')));
-- The reason lists (REASON_CODES in src/core/common/reasons.ts; a unit test
-- keeps the two in step). `proposal_declined` is the resident's answer to a
-- proposal, never picked from the list.
ALTER TABLE "partner_requests" ADD CONSTRAINT "partner_requests_close_reason"
  CHECK ("close_reason" IS NULL
      OR ("status" = 'declined' AND "close_reason" IN ('unavailable', 'out_of_area', 'not_offered', 'other'))
      OR ("status" = 'cancelled' AND "closed_by" = 'resident'
          AND "close_reason" IN ('no_longer_needed', 'found_another', 'wrong_details', 'other', 'proposal_declined'))
      OR ("status" = 'cancelled' AND "closed_by" = 'partner'
          AND "close_reason" IN ('unavailable', 'emergency', 'other'))
      OR ("status" = 'cancelled' AND "closed_by" = 'system'
          AND "close_reason" IN ('partner_suspended', 'requester_left')));

CREATE FUNCTION partner_request_keeps_what_it_asked() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."number" = OLD."number"
     AND NEW."partner_id" = OLD."partner_id"
     AND NEW."unit_id" = OLD."unit_id"
     AND NEW."requester_account_id" = OLD."requester_account_id"
     AND NEW."category" = OLD."category"
     AND NEW."subcategory_id" IS NOT DISTINCT FROM OLD."subcategory_id"
     AND NEW."asked_starts_at" = OLD."asked_starts_at"
     AND NEW."asked_ends_at" = OLD."asked_ends_at"
     AND NEW."gate_pass" = OLD."gate_pass"
     AND NEW."created_at" = OLD."created_at"
     -- The note is kept, or cleared once by an erasure.
     AND (NEW."note" IS NOT DISTINCT FROM OLD."note"
          OR (NEW."note" IS NULL AND OLD."note_cleared_at" IS NULL
              AND NEW."note_cleared_at" IS NOT NULL))
     AND (OLD."note_cleared_at" IS NULL
          OR NEW."note_cleared_at" IS NOT DISTINCT FROM OLD."note_cleared_at")
     -- Accepted once: the agreement never changes.
     AND (OLD."accepted_at" IS NULL
          OR (NEW."accepted_at" = OLD."accepted_at"
              AND NEW."agreed_starts_at" = OLD."agreed_starts_at"
              AND NEW."agreed_ends_at" = OLD."agreed_ends_at"
              AND NEW."staff_count" = OLD."staff_count"))
     -- Closed once: how it closed never changes.
     AND (OLD."closed_at" IS NULL
          OR (NEW."status" = OLD."status"
              AND NEW."closed_at" = OLD."closed_at"
              AND NEW."closed_by" = OLD."closed_by"
              AND NEW."close_reason" IS NOT DISTINCT FROM OLD."close_reason")) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'partner_requests: a request keeps what it asked and moves forward only (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER partner_requests_keep_asked
  BEFORE UPDATE OR DELETE ON "partner_requests"
  FOR EACH ROW EXECUTE FUNCTION partner_request_keeps_what_it_asked();
CREATE TRIGGER partner_requests_keep_asked_truncate
  BEFORE TRUNCATE ON "partner_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- The announced price lines a request named, copied as they were: what the
-- partner announced then, whatever its list becomes. Append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE "partner_request_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "unit" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "partner_request_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "partner_request_items_position_key"
  ON "partner_request_items"("tenant_id", "request_id", "position");
ALTER TABLE "partner_request_items" ADD CONSTRAINT "partner_request_items_request_fkey"
  FOREIGN KEY ("tenant_id", "request_id") REFERENCES "partner_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "partner_request_items" ADD CONSTRAINT "partner_request_items_shape"
  CHECK (char_length("name_en") BETWEEN 1 AND 80 AND char_length("name_ar") BETWEEN 1 AND 80
     AND "price" >= 0 AND "price" <= 999999.99
     AND "quantity" BETWEEN 1 AND 99
     AND "position" BETWEEN 0 AND 9);
ALTER TABLE "partner_request_items" ADD CONSTRAINT "partner_request_items_unit"
  CHECK ("unit" IN ('fixed', 'per_visit', 'visit_fee', 'per_hour', 'per_item', 'per_kg', 'per_sqm'));
CREATE TRIGGER partner_request_items_immutable_rows
  BEFORE UPDATE OR DELETE ON "partner_request_items"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER partner_request_items_immutable_truncate
  BEFORE TRUNCATE ON "partner_request_items"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A request's history: one row per step, who took it (the resident, the
-- partner's desk, the management's relay or the system), a reason's code
-- and the window it named. Append-only. Codes and times only.
-- ----------------------------------------------------------------------------
CREATE TABLE "partner_request_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "actor_account_id" UUID,
    "reason_code" TEXT,
    "starts_at" TIMESTAMPTZ(3),
    "ends_at" TIMESTAMPTZ(3),
    "at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "partner_request_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "partner_request_events_request_idx"
  ON "partner_request_events"("tenant_id", "request_id", "at", "id");
ALTER TABLE "partner_request_events"
  ADD CONSTRAINT "partner_request_events_request_fkey"
  FOREIGN KEY ("tenant_id", "request_id") REFERENCES "partner_requests"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "partner_request_events_actor_account_fkey"
  FOREIGN KEY ("tenant_id", "actor_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "partner_request_events" ADD CONSTRAINT "partner_request_events_kind"
  CHECK ("kind" IN ('created', 'accepted', 'declined', 'proposed', 'proposal_accepted',
    'proposal_declined', 'cancelled', 'done', 'no_show', 'expired', 'lapsed',
    'pass_issued', 'pass_skipped', 'pass_cancelled'));
-- The resident and the relay act as an account; the desk and the system as nobody.
ALTER TABLE "partner_request_events" ADD CONSTRAINT "partner_request_events_actor"
  CHECK ("actor" IN ('resident', 'partner_desk', 'relay', 'system')
     AND ("actor" IN ('resident', 'relay')) = ("actor_account_id" IS NOT NULL));
ALTER TABLE "partner_request_events" ADD CONSTRAINT "partner_request_events_window"
  CHECK (("starts_at" IS NULL) = ("ends_at" IS NULL)
     AND ("starts_at" IS NULL OR "ends_at" > "starts_at"));
ALTER TABLE "partner_request_events" ADD CONSTRAINT "partner_request_events_reason_format"
  CHECK ("reason_code" IS NULL OR "reason_code" ~ '^[a-z][a-z0-9_]{0,39}$');
CREATE TRIGGER partner_request_events_immutable_rows
  BEFORE UPDATE OR DELETE ON "partner_request_events"
  FOR EACH ROW EXECUTE FUNCTION ticket_history_is_immutable();
CREATE TRIGGER partner_request_events_immutable_truncate
  BEFORE TRUNCATE ON "partner_request_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- A partner's desk link: a global pointer, like visitor_pass_links, read
-- before any compound is known. It holds SHA-256("jiwar:partner-desk:v1:"
-- || token), never the token; one live link per partner. It stops working
-- at `expires_at` (the compound's desk_link_days when it was made) or when
-- revoked (a rotation revokes the one before). Nothing else ever changes.
-- ----------------------------------------------------------------------------
CREATE TABLE "partner_desk_links" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_account_id" UUID,
    CONSTRAINT "partner_desk_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "partner_desk_links_token_hash_key" ON "partner_desk_links"("token_hash");
CREATE UNIQUE INDEX "partner_desk_links_one_live"
  ON "partner_desk_links"("tenant_id", "partner_id") WHERE "revoked_at" IS NULL;
CREATE INDEX "partner_desk_links_partner_idx"
  ON "partner_desk_links"("tenant_id", "partner_id", "created_at" DESC);
ALTER TABLE "partner_desk_links"
  ADD CONSTRAINT "partner_desk_links_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "partner_desk_links_partner_fkey"
  FOREIGN KEY ("tenant_id", "partner_id") REFERENCES "partners"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "partner_desk_links_created_by_fkey"
  FOREIGN KEY ("tenant_id", "created_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "partner_desk_links_revoked_by_fkey"
  FOREIGN KEY ("tenant_id", "revoked_by_account_id") REFERENCES "accounts"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "partner_desk_links" ADD CONSTRAINT "partner_desk_links_token_hash_hex"
  CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "partner_desk_links" ADD CONSTRAINT "partner_desk_links_validity"
  CHECK ("expires_at" > "created_at");
ALTER TABLE "partner_desk_links" ADD CONSTRAINT "partner_desk_links_revoked_shape"
  CHECK (("revoked_at" IS NULL) = ("revoked_by_account_id" IS NULL));

CREATE FUNCTION partner_desk_link_is_kept() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."tenant_id" = OLD."tenant_id"
     AND NEW."partner_id" = OLD."partner_id"
     AND NEW."token_hash" = OLD."token_hash"
     AND NEW."created_by_account_id" = OLD."created_by_account_id"
     AND NEW."created_at" = OLD."created_at"
     AND NEW."expires_at" = OLD."expires_at"
     AND OLD."revoked_at" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'partner_desk_links: a desk link is revoked once and otherwise never changes (%)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER partner_desk_links_kept
  BEFORE UPDATE OR DELETE ON "partner_desk_links"
  FOR EACH ROW EXECUTE FUNCTION partner_desk_link_is_kept();
CREATE TRIGGER partner_desk_links_kept_truncate
  BEFORE TRUNCATE ON "partner_desk_links"
  FOR EACH STATEMENT EXECUTE FUNCTION ticket_history_is_immutable();

-- ----------------------------------------------------------------------------
-- Privileges and RLS. A request's row is locked FOR UPDATE, the counter's
-- too, which needs UPDATE; items and events are append-only. The desk links
-- are global: no RLS, reached only through GlobalDbService.
-- ----------------------------------------------------------------------------
REVOKE ALL ON "partner_request_counters", "partner_requests", "partner_request_items",
  "partner_request_events", "partner_desk_links" FROM jiwar_app;
GRANT SELECT, INSERT, UPDATE ON "partner_request_counters", "partner_requests",
  "partner_desk_links" TO jiwar_app;
GRANT SELECT, INSERT ON "partner_request_items", "partner_request_events" TO jiwar_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partner_request_counters', 'partner_requests',
    'partner_request_items', 'partner_request_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- Existing compounds: their counter row.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO "partner_request_counters" ("tenant_id") VALUES (t);
  END LOOP;
END $$;
