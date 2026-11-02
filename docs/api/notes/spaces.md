# Spaces (ADR 0084)

The compound's holiday calendar, its site map, the buildings' floor plans, residents' requests to use a common area, and a facility closure's preview. Codes, ids and fractions; a requester's purpose is theirs (in their export, gone once erased).

## The holiday calendar

### `GET /staff/holidays?from&to` → `200`

**Who:** `spaces.manage`, `permits.manage`, `facilities.manage` or `assets.read`. `from` is today by default, `to` a year on; at most 366 days (`PERIOD_TOO_LONG`, `params.maxDays`).

```json
{
  "data": [
    {
      "id": "…",
      "day": "2026-12-25",
      "nameEn": "Feast",
      "nameAr": "عيد",
      "stopsWorks": true
    }
  ],
  "nextCursor": null
}
```

### `POST /staff/holidays` → `201` · `PATCH /staff/holidays/{id}` → `200` · `DELETE /staff/holidays/{id}` → `204`

**Who:** `spaces.manage`. `{ day, nameEn, nameAr, stopsWorks? }`; the day at most a year back and two years ahead (`DAY_OUT_OF_RANGE`), one a day (`409 HOLIDAY_EXISTS`, `params.day`), at most 100 from today on (`409 HOLIDAYS_TOO_MANY`, `params.max`). A change takes the names and `stopsWorks`; the day is fixed.

- **`stopsWorks`** (on by default): works and moves stop that day — the permits' day off (ADR 0049), refused as before (`NOT_A_WORK_DAY`, the gate's `day_off`). `GET /community/permit-rules` and `GET /staff/permit-settings` still return `daysOff`: these days. A new day off waits for a permit request deciding on it, and the other way round.
- **Flags only.** `GET /facilities/{id}/slots` returns `holiday` (`{ id, nameEn, nameAr }` or null) for its day; `GET /maintenance/plan-calendar` the same on each date. Nothing is refused or moved.

### `GET /community/holidays` → `200`

**Who:** residents and family (`facilities.book`, `permits.request`), guards, technicians. The coming year, today included.

## The site map

- `GET /staff/site-map` (`spaces.manage`, `facilities.manage`, `assets.read`, `gate.read`) and `GET /site-map` (`facilities.book`: active gates and facilities only) → `{ image: { url, expiresAt } | null, points: [{ id, kind, refId, nameEn, nameAr, x, y }] }`. No-store.
- `PUT /staff/site-map/image { fileId }`: an upload of the purpose `site_map` (`FILE_NOT_AVAILABLE`). The points stay; the old image is deleted.
- `PUT /staff/site-map/points { points: [{ kind: building|gate|facility, refId, x, y }] }`: every point, replacing them (at most 500). `x`, `y` are fractions of the image's width and height from its top left corner (0–1). The image first (`409 SITE_MAP_NOT_SET`); a place once (`DUPLICATE_VALUE`) and the compound's (`MAP_PLACE_NOT_AVAILABLE`: a building, a gate, an active facility).

## Floor plans

- `GET /staff/floor-plans?buildingId` (`spaces.manage`, `units.directory`, `assets.read`): `{ id, buildingId, buildingName, floor, hotspots, updatedAt }`.
- `POST /staff/floor-plans { buildingId, floor, fileId }` (`spaces.manage`): one a building floor (`409 FLOOR_PLAN_EXISTS`, `params.planId`); `BUILDING_NOT_FOUND`; an upload of the purpose `floor_plan`.
- `GET /staff/floor-plans/{id}`: the image and `units: [{ unitId, unitCode, x, y, width, height, misplaced }]`; `misplaced`: the unit is on another building or floor now.
- `PUT /staff/floor-plans/{id}/image { fileId }`; `DELETE /staff/floor-plans/{id}` (its boxes and image go).
- `PUT /staff/floor-plans/{id}/hotspots { hotspots: [{ unitId, x, y, width, height }] }`: every box, replacing them (at most 500). Fractions, rounded to five decimals, then `x + width ≤ 1` and `y + height ≤ 1`, both more than 0 (`HOTSPOT_OUTSIDE_IMAGE` on `hotspots.N`); a unit of the plan's building and floor (`UNIT_NOT_ON_FLOOR`; `UNIT_NOT_AVAILABLE`), once (`DUPLICATE_VALUE`). A box the unit had on another floor's plan goes.
- `GET /units/{unitId}/floor-plan` (`units.read`, someone who sees the unit): `{ buildingName, floor, image, unitCode, box }` — the unit's own box or null, never another unit's. `404 FLOOR_PLAN_NOT_FOUND` when its floor has no plan (or the unit no building or floor).

## Common-area use requests

- `PUT|DELETE /staff/space-use-areas/{commonAreaId}` (`spaces.manage`, `204`): open an active area or facility (never a building as a whole: `COMMON_AREA_NOT_FOUND`) to requests, or take no new ones. `GET /staff/space-use-areas` (`spaces.manage`, `bookings.handle`) and `GET /space-use-areas` (`facilities.book`, active only): `{ commonAreaId, code, nameEn, nameAr, facilityId, openedAt }`.
- `POST /units/{unitId}/space-uses { commonAreaId, startsAt, endsAt, purpose, guests? }` (`facilities.book` and the unit's `bookings` capability, `BOOKINGS_NOT_ALLOWED`): at least 24 hours ahead (`SPACE_USE_TOO_SOON`, `params.hours`), within 90 days (`SPACE_USE_TOO_FAR`, `params.days`), at most 12 hours (`SPACE_USE_TOO_LONG`); an open area (`409 SPACE_USE_AREA_CLOSED`); three live per unit (`409 SPACE_USE_LIMIT`, `params.max`); `409 SPACE_USE_OVERLAP` at once when an approved use holds the time.
- `GET /units/{unitId}/space-uses`: the caller's own; the unit's primary sees all (not during a separation). `mine` on each.
- `POST /space-uses/{id}/withdraw { reasonCode }` (`spaceUseWithdraw`, `204`): the requester or the primary, pending or approved (`409 SPACE_USE_DECIDED`, `params.status`), before it starts (`409 SPACE_USE_STARTED`).
- `GET /staff/space-uses?status&commonAreaId`, `GET /staff/space-uses/{id}` (`bookings.handle`): with the unit's code and the purpose.
- `POST /staff/space-uses/{id}/approve`: pending, not started; `409 SPACE_USE_OVERLAP` (an approved use of the area), and on a facility's area `409 SPACE_USE_BOOKED` (`params.bookings`) or `409 FACILITY_CLOSED`. Once approved, the facility is closed to bookings then (`FACILITY_CLOSED`; its slots `closed`).
- `POST /staff/space-uses/{id}/refuse { reasonCode }` (`spaceUseRefuse`), `…/cancel { reasonCode }` (`spaceUseCancel`, an approved use before it ends).
- Statuses: `pending`, `approved`, `refused`, `cancelled` (`reasonCode`: the code, or `requester_left`), `expired` (nobody decided by its start). The requester is told: `space_use.approved`, `.refused`, `.cancelled`, `.expired` (`area`: the area's code; `reason`).
- The staff inbox: type `space_use_request` (`bookings.handle`, 24 hours), approvable in bulk.

## A closure's preview

### `GET /staff/facilities/{id}/closure-preview?startsAt&endsAt` → `200`

**Who:** `facilities.manage`. No-store. The window as a closure's (`ENDS_BEFORE_START`, `CLOSURE_TOO_LONG`).

```json
{
  "bookings": [
    {
      "id": "…",
      "unitCode": "A-101",
      "startsAt": "…",
      "endsAt": "…",
      "status": "confirmed",
      "charge": {
        "amount": "150.00",
        "status": "paid",
        "outcome": "unit_credit"
      }
    }
  ],
  "invoicesCredited": "0.00",
  "unitCredit": "150.00",
  "previewToken": "9f…(64 hex)"
}
```

- `outcome`: `invoice_credited` (an unpaid fee: the invoice is credited, nothing owed) or `unit_credit` (a paid fee: the money is the unit's credit; cash back through the manager's refund). A booking with no fee, or one credited already, has `charge: null`.
- `POST /staff/facilities/{id}/closures` takes `previewToken`. Without it, a closure that cancels a booking with a fee is `409 FACILITY_CLOSURE_PREVIEW_REQUIRED`; with it, the closure cancels and credits exactly what was previewed, or is `409 FACILITY_CLOSURE_PREVIEW_STALE` (a booking made, cancelled or paid since, another window, or the same preview closed already). Preview again and send the new token.
