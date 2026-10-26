-- ============================================================================
-- A roster slot ends when the compound's clock reads its window's end
-- (ADR 0050): a 22:00–06:00 night lasts nine hours when the clock goes back,
-- seven when it goes forward. Slots made before kept their window's length
-- in real time, so the night of a clock change ended an hour early or late
-- (05:00 on Cairo's 29 → 30 October 2026). This repairs the slots to come:
-- each template slot not yet started gets the end its template gives it
-- now, as `windowEnd` in src/gate/roster/roster-rules.ts computes it.
--
-- Which rows: scheduled template slots that start after now. A slot under
-- way or past, a single slot (its times are the manager's), and a
-- cancelled one keep theirs. A slot whose new end would overlap another
-- of its guard's (a single slot made to cover the missing hour, say) keeps
-- its end too: a guard's slots never overlap.
--
-- How: as the code does, not as `AT TIME ZONE` does. A time read twice is
-- its first reading (Postgres takes the second), and a time the clock
-- skips moves to the first minute that exists (Postgres moves it by the
-- gap). A slot lasts a day at most (the CHECK).
--
-- The slots' trigger keeps a slot's times for good; it is set aside for
-- this one UPDATE, inside the same block, so it is back on whatever
-- happens. One compound at a time: the table is under FORCE RLS. The two
-- helpers are this migration's own and are dropped at its end.
-- ============================================================================

CREATE FUNCTION "roster_repair_first_instant"(d date, m int, tz text)
  RETURNS timestamptz
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  minute int;
  wall timestamp;
  reading timestamptz;
  probe timestamptz;
BEGIN
  FOR minute IN m .. LEAST(m + 119, 1439) LOOP
    wall := d + make_interval(mins => minute);
    reading := wall AT TIME ZONE tz;
    -- The earliest instant that reads `wall`: a time read twice has two.
    FOREACH probe IN ARRAY ARRAY[
      reading - interval '2 hours',
      reading - interval '1 hour',
      reading - interval '30 minutes',
      reading
    ] LOOP
      IF (probe AT TIME ZONE tz) = wall THEN
        RETURN probe;
      END IF;
    END LOOP;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "roster_repair_slot_end"(starts timestamptz, schedule jsonb, tz text)
  RETURNS timestamptz
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  d date := (starts AT TIME ZONE tz)::date;
  w jsonb;
  from_min int;
  to_min int;
  len int;
  end_min int;
  ends timestamptz;
BEGIN
  FOR w IN SELECT value FROM jsonb_array_elements(schedule -> 'windows') LOOP
    from_min := split_part(w ->> 'from', ':', 1)::int * 60
              + split_part(w ->> 'from', ':', 2)::int;
    -- The window this slot was made from starts at its start that day.
    CONTINUE WHEN "roster_repair_first_instant"(d, from_min, tz) IS DISTINCT FROM starts;
    to_min := split_part(w ->> 'to', ':', 1)::int * 60
            + split_part(w ->> 'to', ':', 2)::int;
    len := (to_min - from_min + 1440) % 1440;
    end_min := from_min + len;
    ends := COALESCE(
      "roster_repair_first_instant"(
        CASE WHEN end_min >= 1440 THEN d + 1 ELSE d END,
        end_min % 1440,
        tz
      ),
      starts + make_interval(mins => len)
    );
    RETURN LEAST(ends, starts + interval '24 hours');
  END LOOP;
  -- No window starts then: the slot keeps its end.
  RETURN NULL;
END;
$$;

DO $$
DECLARE
  t record;
BEGIN
  ALTER TABLE "guard_roster_slots" DISABLE TRIGGER "guard_roster_slots_move_forward";
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    WITH due AS (
      SELECT s."id", s."guard_account_id", s."starts_at", s."ends_at",
             "roster_repair_slot_end"(s."starts_at", tp."schedule", ts."timezone") AS new_end
        FROM "guard_roster_slots" s
        JOIN "guard_roster_templates" tp
          ON tp."tenant_id" = s."tenant_id" AND tp."id" = s."template_id"
        JOIN "tenant_settings" ts ON ts."tenant_id" = s."tenant_id"
       WHERE s."tenant_id" = t."id"
         AND s."status" = 'scheduled'
         AND s."starts_at" > now()
    ), changed AS (
      SELECT * FROM due
       WHERE new_end IS NOT NULL
         AND new_end > "starts_at"
         AND new_end <> "ends_at"
    )
    UPDATE "guard_roster_slots" s
       SET "ends_at" = c.new_end
      FROM changed c
     WHERE s."tenant_id" = t."id"
       AND s."id" = c."id"
       AND NOT EXISTS (
         SELECT 1
           FROM "guard_roster_slots" o
           LEFT JOIN changed oc ON oc."id" = o."id"
          WHERE o."tenant_id" = t."id"
            AND o."guard_account_id" = c."guard_account_id"
            AND o."id" <> c."id"
            AND o."status" = 'scheduled'
            AND o."starts_at" < c.new_end
            AND GREATEST(o."ends_at", COALESCE(oc.new_end, o."ends_at")) > c."starts_at"
       );
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  ALTER TABLE "guard_roster_slots" ENABLE TRIGGER "guard_roster_slots_move_forward";
END $$;

DROP FUNCTION "roster_repair_slot_end"(timestamptz, jsonb, text);
DROP FUNCTION "roster_repair_first_instant"(date, int, text);
