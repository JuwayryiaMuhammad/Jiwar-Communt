# 0084 — Spaces: the compound's holiday calendar (taking over the permits' days off), the site map, floor plans with unit boxes, common-area use requests, and a closure's preview

**Status:** Accepted · M2-14 · amends ADR 0044 (a closure with a fee at stake is previewed first; an approved use closes a facility to bookings), 0049 (the days off are the calendar's), 0064 (common areas open to residents' requests; the plans' calendar flags holidays), 0070 (the closure's credits shown before they are made), 0073 (an inbox type)

## Context

The manager audit of 2026-11-01 (group C of assets, the operations row "اعتماد طلب استخدام مساحة مشتركة") found: no shared holiday calendar — only the permits' dated days off (`permit_settings.days_off`, ADR 0049), while plans, readiness and facility days had none (0064, 0067 Open); common areas with an optional position but no map; plans as maintenance documents but no floor plan with units on it; no request to use a common area that is not a bookable facility; and a facility closure that cancels and credits bookings with no preview of what it would do.

## Decisions

### The holiday calendar

- **`compound_holidays`**: a dated local day, its names (English and Arabic, 1–80), and `stops_works` (on by default). One a day (`compound_holidays_one_a_day`, HOLIDAY_EXISTS), dated at most a year back and two years ahead (DAY_OUT_OF_RANGE), at most **100 from today on** (HOLIDAYS_TOO_MANY: the permits' old cap of 100 days off). The day is its key: never moved (remove it and add another). Kept at `/staff/holidays` (`spaces.manage`); read by the staff who plan around it (`spaces.manage`, `permits.manage`, `facilities.manage`, `assets.read`), and by the apps at `GET /community/holidays` (the coming year).
- **`holiday_calendars`**: the compound's lock row, made with it (`HolidayProvisioning`; the migration for every existing compound). A write takes it FOR UPDATE; a permit decision takes `permit_settings`' row FOR SHARE and then this one FOR SHARE, so a new day off and a request on that day go one after the other, as a change of the days off and a request did. The row's `updated_at` says when the calendar last changed.
- **The permits' days off are the holidays that stop works.** The migration moves every `permit_settings.days_off` day into the calendar ("Day off" / "يوم عطلة", stopping works) and drops the column and its CHECK. Every reader — the requests, the approvals and appeals, the gate's entries and lookups, the offline bundle (ADR 0057) — reads `readWorkRules` (`permit-work-rules.ts`), which returns the same `WorkRules` with `daysOff` filled from the calendar: `isWorkDay`, `workTimeRefusal` and `day_off` are unchanged, and so is every refusal. The permit views still carry `daysOff` (read-only now); `PATCH /staff/permit-settings` no longer takes it (`FIELD_NOT_ALLOWED`).
- **Everything else is flagged, never refused or moved.** A facility's slots of a day carry `holiday` (its names; the slots are what the facility's hours make them); the planned work calendar's dates carry `holiday` (ADR 0076: the due dates are not shifted).

### The site map

- **`site_maps`** (one per compound: an image of purpose `site_map`, through the files service, ADR 0029) and **`site_map_points`**: one point per building (ADR 0072), gate or active facility (`MAP_PLACE_NOT_AVAILABLE`; once each, `DUPLICATE_VALUE` and three partial unique indexes), at **fractions of the image's width and height** from its top left corner (0–1, CHECK). The image first (`SITE_MAP_NOT_SET`); points are replaced whole (at most 500); a new image keeps them, and the old file is marked deleted (`replaced`). Writers take the map's advisory lock.
- `GET /staff/site-map` for the staff, `GET /site-map` for the apps (`facilities.book`: buildings, active gates, active facilities). Both no-store (a presigned image).

### Floor plans

- **`floor_plans`**: one image (purpose `floor_plan`) per building and floor (`FLOOR_PLAN_EXISTS`, the building's advisory lock); **`floor_plan_units`**: a unit's box, x/y/width/height as fractions, **inside the image** (`HOTSPOT_OUTSIDE_IMAGE` and CHECK `floor_plan_units_inside`, checked on the values rounded to five decimals as stored), for a unit of the plan's own building and floor (`UNIT_NOT_ON_FLOOR`), once per plan and on one plan only (a box the unit kept on another floor's plan goes when it is drawn on its own). Boxes are replaced whole under the plan's row lock.
- A unit moved since its box was drawn shows `misplaced` to the staff. **A household** (`GET /units/{unitId}/floor-plan`, `units.read`, someone who sees the unit) gets its own floor's plan: the image, the building, the floor, its own code and **its own box only** — never another unit's box, code or anyone in it; none on its floor is `FLOOR_PLAN_NOT_FOUND`.

### Common-area use requests

- **`space_use_areas`**: the common areas (ADR 0064; an area or a facility's, never a building as a whole) the management opened to requests (`spaces.manage`). Closing one takes no new requests; what was asked or approved stands.
- **`space_use_requests`**: a household that books for the unit (`facilities.book`, its `bookings` capability) asks for an open area for a time — **at least 24 hours ahead, within 90 days, at most 12 hours** (CHECK), **three live per unit** (under the unit's lock) — with a purpose (the requester's words: plain data, in their export, NULL once erased; never audited or in a notice) and a number of guests. The staff (`bookings.handle`) approve it or refuse it with a code (`spaceUseRefuse`), and may cancel an approved one before it ends (`spaceUseCancel`); its requester or the unit's primary (not during a separation) withdraws it before it starts (`spaceUseWithdraw`). Nobody's decision by its start: it expires (the sweep `facilities.space_uses_expire`, once). The requester is told of each (`space_use.approved/refused/cancelled/expired`, the area's code and a reason code). A request keeps what it asked for; a closed one changes only by its purpose's erasure (trigger).
- **The race is the approval.** Approved uses of one area never overlap (`SPACE_USE_OVERLAP`), and a facility's area never holds an approved use and a booking at once: the approval takes the facility's row FOR UPDATE (a booking holds it FOR SHARE), then the area's row FOR UPDATE, then the request's, and refuses a holding booking (`SPACE_USE_BOOKED`, `params.bookings`) or a closure in force (`FACILITY_CLOSED`). The other way, `closedOver` (bookings, stays, the waitlist) counts an approved use as the facility closed, and the slots show it `closed`.
- **The inbox**: a pending request is the type `space_use_request` for `bookings.handle` (24 hours), approvable in bulk through its own approve.
- **Leaving**: deactivated, erased or no longer booking for the unit, the requester's live requests that have not started are cancelled by the system (`requester_left`), nobody told.

### A closure's preview

- `GET /staff/facilities/{id}/closure-preview?startsAt&endsAt` (`facilities.manage`, no-store): the bookings the closure would cancel (the same ones it cancels: holding a place in the window, not started), each with its unit's code and its fee's fate — an unpaid invoice **credited** (nothing owed), a paid fee **to the unit's credit** (ADR 0070's one credit path; cash back only through the manager's refund) — the two totals, and a **token**: a digest of the facility, the window and each booking's id, status, fee status and amount.
- `POST …/closures` takes `previewToken`. A closure that would cancel a booking with a fee not credited is refused without one (`FACILITY_CLOSURE_PREVIEW_REQUIRED`); with one, the closure recomputes the digest **after the facility's row and the charged units' finance locks** — nothing can book, cancel or pay those bookings then — and applies exactly what was previewed, or refuses (`FACILITY_CLOSURE_PREVIEW_STALE`): a booking that landed in between, a fee paid in between, another window, or a second close of the same preview (the first cancelled them). A closure with no fee at stake needs no preview, as before. Its audit entry says whether it was previewed and the two totals.

### Permissions, registries

- New permission **`spaces.manage`** (staff, manager; the manager's by default): the holidays, the site map, the floor plans and the areas open to requests.
- File purposes `site_map`, `floor_plan` (images, the 10 MB default; neither files CHECK names them); inbox type `space_use_request` (both inbox CHECKs widened); reason lists `spaceUseRefuse`, `spaceUseCancel`, `spaceUseWithdraw`; 16 audit actions; four notification kinds.

## Deviations for the owner

1. **Holidays flag; they never shift or block** bookings, plans, inspections or readiness. The audit's "per-plan shift to the next working day" is left out (Open); a holiday that stops works blocks exactly what the permits' days off blocked.
2. **The days off are edited on the calendar only**: `PATCH /staff/permit-settings` refuses `daysOff` (`FIELD_NOT_ALLOWED`) instead of writing into the calendar; the permit views still return them.
3. **Inspections, readiness and facility hours** read nothing of the calendar yet; only facility days and the planned work calendar are flagged.
4. **Positions are fractions of the image**, not pixels: "inside the image" is exact without reading the image's size, and a sharper scan of the same drawing keeps every point and box.
5. **A box per unit**, a rectangle; no polygons, no CAD layers.
6. **Use requests carry no fee** (the audit's ChargesPort option) and no conditions text; the rules (24 hours, 90 days, 12 hours, three live) are fixed, not settings.
7. **An approved use closes a facility's area to bookings** (as a closure would, without cancelling anything); a closure made over an approved use leaves the use as it is.
8. **The site map is shown to the apps too**, with the active places only.
9. **The closure's only refund is the existing credit path** (an unpaid invoice credited, a paid one to the unit's credit); no other refund action is offered in the preview.

## Consequences

- New tables `holiday_calendars`, `compound_holidays`, `site_maps`, `site_map_points`, `floor_plans`, `floor_plan_units`, `space_use_areas`, `space_use_requests`; `permit_settings.days_off` and its CHECK dropped; two file purposes; the inbox CHECKs widened.
- Migrations 20270420090000 (the purposes), 090100 (the calendar, the days off moved in), 090200 (the map and the plans), 090300 (use requests, the inbox).
- The manager dashboard: Holidays, Site map, Floor plans (and a plan's page), Common-area uses; a closure's preview in the close dialog; holidays on the planned work calendar; the permit settings' days off read-only.

## Open

- A per-plan "shift to the next working day", and holidays read by inspections, readiness and facility hours.
- A fee and conditions on a use request; settings for its rules.
- A closure over an approved use (cancel it, or refuse the closure); the closure linked to its work order (0064 Open).
- Positions for parking areas and checkpoints on the site map.
- Occupancy of walk-in spaces stays deferred (audit decision 8).
