# 0072 — The unit register: the compound's buildings, the manager's edit of a unit, the register's filters and CSV, a unit's occupancy history and workers, sheets of units and residents, and the staff's search

**Status:** Accepted · M2-1 · amends ADR 0012 (units: a building id beside the name; the manager edits a unit), 0058 (the search's registry pattern, now for the staff too), 0064 (the sheet design, for units and residents)

## Context

M2 is the first manager phase after the resident, guard and technician roles were completed. The manager audit (2026-11-01, five slices of the compound manager's spec against main at f38c78a4) found the unit register the base most of M2 builds on: units could not be edited (`POST /units` took a code, a building and a floor, nothing else), the units list had no search, filters or export, buildings were free text on the unit, there was no bulk import, the unit card had no history and could not show the unit's workers (the residents' route needs `workers.manage`, which only residents hold), and the dashboard's top bar had no search. The owner approved the plan and every recommendation of the five audits on 2026-11-01, among them: a real buildings table backfilled from the text; the unit code never edited; bulk import of units and of residents with their places, a dry run then a commit, no emails.

## Decisions

### Buildings

- `buildings` (a name, unique exactly as written in the compound, 1–64 characters, trimmed). A unit keeps its text `building` and gains `building_id` (a composite foreign key). Audiences, partners' service areas, governance and finance read and store building **names** (ADR 0040, 0060, 0059, 0048), so the text stays the key they match, and moving them to ids is left to the phases that touch them.
- **One trigger keeps the two in step** whichever a write sets: the id brings the building's name (the manager's edit); the text brings the building of exactly that name, a new one when there is none (`ON CONFLICT DO NOTHING`, so two units naming one new building at once share it). Every existing writer — the registration's activation, seeds, tests that write the text — keeps working. A CHECK: both or neither.
- **Never renamed** (a trigger refuses any change), since the name is a key elsewhere; **deleted** only when no unit names it (the foreign key; `409 BUILDING_IN_USE` with the count). A unit created by name brings its building; the manager may also add one ahead of its units.
- **Backfill:** a building per distinct name per compound; a name over 64 characters (the registration never bounded it) cut to 64, the unit's text with it; blank text cleared. The registration now refuses a building over 64 characters.
- **Locks:** a unit's edit takes the unit's lock (ADR 0012's order: the unit first), then holds the building `FOR KEY SHARE`, as the trigger does; a delete takes the building `FOR UPDATE` and counts its units. A move and a delete at once end either way consistently: the unit in the building and the delete refused, or the building gone and the move `404 BUILDING_NOT_FOUND`. Row locks need `UPDATE`, so the app holds it on `buildings`; the trigger refuses every change.

### The manager's edit

- `PATCH /units/{id}` (new permission `units.manage`, the manager's): `buildingId`, `floor`, `unitType`, `areaSqm` (above zero), null clears each. **The code is never changed** (`FIELD_NOT_ALLOWED`): QR codes, permits and certificates print it. Audited `unit.updated` with what changed (none when nothing did). `POST /units` also takes a building by id, a type and an area (a name and an id together is refused).

### The register's reads

- `GET /units` takes `q` (part of the code, any case) and `buildingId` for anyone who lists units, and `status` (`vacant | occupied | closed`) and `occupancyType` for the manager only: `units.directory` (the security supervisor) lists codes, buildings and floors, never who lives there (ADR 0053), so those two are `FIELD_NOT_ALLOWED` for it and for residents. `closed` is closed-unit mode; the rest are `occupied` (someone holds a place) or `vacant`.
- `GET /staff/units/export` (units.manage, no-store): the same filters as CSV by code — building, floor, type, area, status, and how many hold a place as owners, as tenants and living there. Counts, never names; the shared CSV writer defuses formulas; at most `ExportLimit` rows.
- `GET /staff/units/{unitId}/occupancy-history` (residents.read): every occupancy of the unit, live or ended (they are never deleted), newest first, paged; an erased account reads as erased.
- A unit's workers for the manager: `GET /worker-engagements?unitId=` (workers.review), a filter on the review list rather than a new route.

### Sheets of units and residents

- As asset sheets (ADR 0064): `POST /staff/unit-imports {kind, fileId}` checks a `data_import` CSV whole and keeps its problems (`{ line, field, code }`, the first 100, never a cell's text): `valid` or `invalid`; `POST …/{id}/apply` checks it again and creates every row in one transaction, or none (the import becomes `invalid`). Applied once, under the import's row lock. Both `units.manage` and `residents.manage` are needed; `units.manage` may upload a `data_import` file.
- **Units** (up to 2000 rows): `code` (1–32, once in the sheet, not the compound's already), and `building` (a name: found or added by the trigger), `floor`, `unit_type`, `area_sqm`.
- **Residents** (up to 300 rows): one row a person and their place — `full_name`, `phone`, `email` (each once in the sheet and no resident's of the compound already), `id_document_type` and `id_document_number` (ADR 0018's check, with `nationality` and `birth_date` for a passport), `unit` (a code), `occupancy_type`, and `resides`, `preferred_locale`. A second unit for a person is added from their page. Applying locks the units first, then creates each account and place as the manager's own creation does. **No email goes out**: the management invites people when it chooses.
- **A valid import is applied within a day** of its upload, or it expires (the hourly `units.imports` sweep; an apply after a day is refused even before the sweep). `409 UNIT_IMPORT_NOT_VALID` carries the status; a sheet a spreadsheet would not write is `422 UNIT_IMPORT_UNREADABLE`, with no import left.
- **A residents sheet holds people's details,** so its file is let go — marked deleted, then purged by the files' sweep (ADR 0029) — once the import can no longer be applied: found invalid, applied or expired. A CHECK keeps it only while the import is valid. A units sheet holds nothing personal and is kept, as an asset sheet is.
- Audit: `unit_import.checked`, `.applied`, `.expired` (kind and counts); an imported unit's `unit.created` says `imported`.

### The staff's search

- A core registry, `StaffSearch`, as the residents' (ADR 0058): each domain registers its sources at startup (all kinds checked at bootstrap). `GET /staff/search?q=` (2–64 characters, no-store, 60 a minute an account), for an account holding the permission of at least one kind's list — so the staff and the manager; a resident is `FORBIDDEN` before the query is read (they have `GET /me/search`). At most 8 a kind; a hit is its kind, id, title and subtitle.
- Each kind answers only to a caller holding its list's permission: units by part of the code and buildings by name (`units.manage` or `units.directory`); residents and family by name, or exactly by phone or email (`residents.read`), the staff likewise (`accounts.read`) — the name only, never an erased account; tickets by number (`tickets.dispatch` or `maintenance.manage`); assets by code or name (`assets.read`). Vendors and documents join with their phases.

## Deviations for the owner

1. **Buildings are never renamed** in this phase. Their name is stored as a key by audiences, partners' service areas and governance; a rename would need those moved to ids first. To fix a misspelt building: add the right one, move its units, delete the old one.
2. **One resident a row** in a residents sheet; a second unit is added from the resident's page (simpler checks: an email or a phone once a sheet).
3. **A unit's workers** come from a `unitId` filter on `GET /worker-engagements`, not a new `GET /staff/units/{unitId}/workers`.
4. **Imports need both `units.manage` and `residents.manage`** (the manager holds both); no split by kind.
5. **No saved searches** in the top bar yet (the audit's X1 lists them); the registry takes them later.
6. **Units' `status` and `occupancyType` filters are the manager's only**, so the security supervisor's directory stays without people.

## Consequences

- Later phases move what keys on building names (audiences, partners' service areas, governance's building votes, finance's issue by building) to ids at their own pace; until then the trigger keeps names and ids together.
- The staff's search grows by registering sources (vendors in M2-5, compound documents).
- Tests: buildings and the edit (races: a move against a delete, two units naming one new building), the register's reads, imports (race: two applies), the search, audit coverage, isolation, registry rows, no-store calls.
