# The unit register: backend notes for the manager's dashboard

What was built for the manager's units (M2-1):
- the compound's buildings, and a building id on every unit;
- editing a unit (never its code);
- searching and filtering the units, and the CSV;
- a unit's occupancy history and workers;
- sheets of units and of residents;
- the top bar's search.

The design decisions are in [ADR 0072](../../decisions/0072-unit-register.md). The contract is `docs/api/openapi.v0.json` (regenerated), with the Postman collection. Conventions are as everywhere in API v0: paths under `/api/v1`, a bearer token, errors switched on `code` and `fields[].code`.

## Contents

1. [Buildings](#buildings)
2. [Editing a unit](#editing-a-unit)
3. [The units list and the CSV](#the-units-list-and-the-csv)
4. [A unit's history and workers](#a-units-history-and-workers)
5. [Sheets of units and residents](#sheets-of-units-and-residents)
6. [The staff's search](#the-staffs-search)
7. [Lists a picker searches](#lists-a-picker-searches)

## Buildings

- `GET /buildings` (`units.manage` or `units.directory`): every building by name, `{ id, name, units, createdAt }` (`units` = how many name it now). Not paged.
- `POST /buildings { name }` (`units.manage`): 1–64 characters, unique as written. `409 BUILDING_NAME_TAKEN`.
- `DELETE /buildings/{id}` (`units.manage`): `204`; `409 BUILDING_IN_USE` with `params.units` while units name it; `404 BUILDING_NOT_FOUND`.
- A building is **never renamed**. To fix a misspelt one: add the right one, move the units to it, delete the old one.
- `POST /units` with `building` (a name) finds or adds the building of exactly that name; with `buildingId`, the unit goes in that building. Not both (`buildingId` `FIELD_NOT_ALLOWED`). Every unit view (`UnitView`, `UnitDetailView`) carries `building` (the name) and `buildingId`, both null or both set.

## Editing a unit

- `PATCH /units/{id}` (`units.manage`) with any of `buildingId`, `floor` (−5 to 200), `unitType`, `areaSqm` (a decimal string above zero, two decimals at most). `null` clears a field; a field left out is unchanged. Answers the unit (`UnitDetailView` without the manager's extras).
- `code` is refused (`FIELD_NOT_ALLOWED`): QR codes, permits and certificates print it.
- `404 BUILDING_NOT_FOUND` for a building that is not the compound's (or was just deleted).

## The units list and the CSV

- `GET /units?q&buildingId&status&occupancyType&cursor&limit`:
  - `q`: part of the code, any case. `buildingId`: one building.
  - `status`: `vacant` (nobody holds a place, not closed), `occupied` (someone does, not closed), `closed` (closed-unit mode). `occupancyType`: `owner` or `tenant` (someone holds a place as that).
  - `status` and `occupancyType` are the manager's (`units.manage`): for anyone else they are `FIELD_NOT_ALLOWED`.
- `GET /staff/units/export` (`units.manage`) with the same filters: `text/csv` (UTF-8 with a BOM), by code, columns `code, building, floor, unit_type, area_sqm, status, owners, tenants, residing`. Counts, never names. `422 EXPORT_TOO_LARGE` past 100 000 rows.

## A unit's history and workers

- `GET /staff/units/{unitId}/occupancy-history` (`residents.read`), paged, newest start first: `{ occupancyId, account: { id, fullName }, occupancyType, resides, isPrimary, status, startedAt, endedAt, endReason, handedOverAt }`. An erased account comes as erased (`fullName` null).
- `GET /worker-engagements?unitId=` (`workers.review`): the unit's workers, as in the review list.

## Sheets of units and residents

Upload the CSV as a `data_import` file (`POST /files`, `PUT`, `POST /files/{id}/finalize`), then:

- `POST /staff/unit-imports { kind: "units" | "residents", fileId }` (`units.manage` and `residents.manage`; send an `Idempotency-Key`): the sheet checked whole. Answers `{ id, kind, status: "valid" | "invalid", rowCount, errorCount, errors: [{ line, field, code }], appliedCount, createdAt, appliedAt }`. `line` 1 is the header; `field` is the column; `code` a field error code (`FIELD_REQUIRED`, `FIELD_NOT_ALLOWED`, `INVALID_LENGTH`, `INVALID_NUMBER`, `INVALID_VALUE`, `DUPLICATE_VALUE`, `INVALID_PHONE`, `INVALID_EMAIL`, `INVALID_NATIONAL_ID`, `UNIT_NOT_AVAILABLE`, …). Never a cell's text. A sheet that is not clean CSV: `422 UNIT_IMPORT_UNREADABLE` with `params.problem` (and `params.line`).
- `POST /staff/unit-imports/{id}/apply`: within a day of the upload, every row or none. If something changed since the check (a code taken, an email used), the answer is the import, now `invalid`, with the new problems; nothing was created. Otherwise `applied` with `appliedCount`. `409 UNIT_IMPORT_NOT_VALID` with `params.status` (`applied`, `invalid` or `expired`) for one that cannot be applied.
- `GET /staff/unit-imports`, `GET /staff/unit-imports/{id}`.
- **Units columns:** `code` (required); `building` (a name), `floor`, `unit_type`, `area_sqm`. Up to 2000 rows.
- **Residents columns:** `full_name`, `phone`, `email`, `id_document_type` (`national_id` | `passport`), `id_document_number`, `unit` (a code), `occupancy_type` (`owner` | `tenant`) required; `nationality` and `birth_date` (a passport needs both), `resides` (`true` | `false`; a tenant lives there), `preferred_locale` (`ar` | `en`). One row a person; up to 300 rows. Nobody imported is emailed.
- A residents sheet is deleted as soon as the import is found invalid, applied, or a day old (then `expired`).

## The staff's search

- `GET /staff/search?q=` (2–64 characters; for an account holding the permission of at least one kind's list; 60 a minute): `{ data: [{ type, id, title, subtitle }] }`, at most 8 of each `type`: `unit`, `building`, `resident`, `staff`, `ticket`, `asset`. Each type only when the account holds its list's permission. `q` may be a reference (`MT-000123`, `123`) or words; a resident is also found by exactly their phone or email. Residents get `403 FORBIDDEN` (they have `GET /me/search`).

## Lists a picker searches

A picker no longer reads the first 100 rows of a list: the lists it reads take a text to search, and the next page (`cursor`) continues the same search.

| Route | Parameter | Finds |
| --- | --- | --- |
| `GET /units` | `q` (1–32) | Part of the code, any case (as before). |
| `GET /staff/vendors` | `q` | Part of the name (as before). |
| `GET /accounts` (`accounts.read`) | `q` (2–64) | Part of the name, any case; or exactly the phone or the email. An erased account is never found. |
| `GET /residents` (`residents.read`) | `q` (2–64) | The same, among the resident accounts. |
| `GET /maintenance/assets` (`assets.read`) | `q` (1–64) | Part of the code, the English name or the Arabic name. |

`GET /accounts` also takes `group` (`staff`: staff and manager accounts; `managers`; `households`: resident and family accounts) and `active=true` (only the accounts that can sign in), so a picker that names an owner, a manager or a household's person asks for exactly them. Anything else is `400 INVALID_VALUE` with `allowed`; a `q` shorter than its minimum is `400 INVALID_LENGTH`. The views and the permissions are the lists' own.
