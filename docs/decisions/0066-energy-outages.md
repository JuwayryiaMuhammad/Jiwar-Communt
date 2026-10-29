# 0066 — Energy and utilities: meters, readings and their imports, consumption computed on read, tariffs, spikes, saving measures and utility outages

**Status:** Accepted · M1-3a · amends ADR 0036 (a notification category), 0064 (the `data_import` sheet)

## Context

The roles' list gives the compound manager the compound's electricity, water, gas and fuel: by building and zone, compared, by the square metre, with unusual rises, generators, efficiency and the effect of saving measures. Until now nothing measured anything: the only trace was the move step `meters_read` (ADR 0063). R11c, the resident's own unit, will read its unit's meters. M1-3b (ADR 0067) takes readiness, facility bans and the technician's safety.

## Decisions

### Permissions

- **`energy.read`:** meters, readings, consumption, spikes, tariffs, measures and outages. The maintenance supervisor and the manager.
- **`energy.manage`:** keeps them. The same two.
- **`meters.record`:** a technician (and the supervisor) records a meter's reading.
- A unit's consumption shows when it stands empty, so a technician never holds `energy.read`.

### Meters

- **The record:** a code, a kind, a mode and a multiplier.
  - Kinds: `electricity` (kWh), `water` (m³), `gas` (m³), `fuel` (L) or `run_hours` (h).
  - Mode: `cumulative` (the register as it stands) or `interval` (what was used since the last reading).
- **Place:** a unit or a common area, or an asset, in which case it stands where the asset stands.
- **Fixed for life** (a trigger): the code, kind, mode, multiplier and place. A replaced meter is retired and a new one added, or it takes a reset reading.
- **Retirement:** once, with a `meterRetire` reason; then it never changes.

### Readings

- **Day:** a reading is a day of the compound's calendar (`readOn`, `@IsLocalDate`), by today and at most 400 days back.
- **One live reading a meter and day** (a partial unique index); another is `409 READING_EXISTS {readingId}`.
- **Never edited** (a trigger).
  - **Correction:** supersedes a reading once with a `readingCorrect` reason. It is a new row, checked without the row it corrects.
  - **Withdrawal:** supersedes it with nothing after.
  - A second of either is `409 READING_ALREADY_CORRECTED`.
- **Reset:** a reset reading starts the register again from zero.
- **Lock order:** the caller's account FOR SHARE, then **the meter FOR UPDATE**, then its live readings. Two readings, a correction or an import on one meter are decided one after the other, never against a stale view.
- **Both neighbours:** a cumulative register is checked against the live readings on both sides, since a reading may be backdated. A reset reading, or a reset after it, ends the check on that side.
  - Below the one before: `400 value READING_BELOW_PREVIOUS {previous}`.
  - Above the one after: `400 value READING_ABOVE_NEXT {next}`.
- **The technician:** sees only the meter they read (`GET /technician/meters/:id`): its code, kind and place, its last live reading, and the range today's is expected in. Never its history or its use.
  - The range runs from the last reading to that plus the mean daily use over the days since, times the spike factor.

### Spikes

- **Only on the latest live reading:** a backdated one raises nothing.
- **The rule:** the period's daily use above the mean of the compound's number of periods before it, times its factor. The mean needs three periods.
- **Settings:** on the compound's maintenance settings, `anomaly_factor` (2.00, from 1.2 to 10) and `anomaly_periods` (6, from 3 to 24), changed with `energy.manage`. These are columns, not a table of their own: every compound already has its row.
- **Once per meter and day** (a unique key, ON CONFLICT DO NOTHING), told to `energy.manage` holders (`meter.anomaly`), acknowledged once.

### Reading imports

- **Like the asset register's** (ADR 0064): a `data_import` sheet of `meter`, `read_on`, `value` and `reset` (`energy.manage` may upload one).
- **Checked whole** against the meters and their live readings, the sheet's own rows among them. Problems name a line, a column and a code, never a cell.
- **Applied once:** under the caller's account FOR SHARE, the import FOR UPDATE, then its meters FOR UPDATE in code order. Every row is written or none; what changed since makes it invalid.

### Consumption, computed on read

- **Nothing stored to go stale:** each period between two live readings is spread evenly over its days, and the part inside the window counts.
  - **Use:** the register's climb (from zero after a reset), or the interval's figure, times the multiplier.
- **Grouped by:**
  - meter;
  - building: a unit's, or a building common area's;
  - common area.
- **To compare buildings by:** use a square metre (`units.area_sqm`) and a unit someone lives in now.
- **Periods:** the compound's days, both ends included, real dates, at most 366 days (ADR 0065).
- **A meter's own report** is by month. Each report also comes as CSV (formula cells defused).

### Tariffs

- **What a unit of a kind costs from a day on** (`effectiveOn`), never edited: a later day's tariff takes over. One a kind and day.
- **Pricing:** each day is priced at the tariff in force. A day before any tariff counts its use and no cost.

### Saving measures

- **The record:** something done to use less, on one meter (of its kind), one building, or the compound, from a day (`startsOn`, at most a year ahead), with what it cost. Ended once (`endedOn`, from its start to today).
- **Its effect is read now:** the use a day over whole weeks before its start against the same weeks from it, 1 to 26 weeks (4 by default), so both sides hold the same days of the week.
  - The after side stops at today or its end, and is complete only with all its days.

### Utility outages

- **The record:** water, electricity, gas or another supply cut off, with its `scope` said, never implied: `compound`, naming no building, or `buildings`, naming 1 to 50 (`utility_outages_scope_shape`; otherwise `buildings` FIELD_NOT_ALLOWED or FIELD_REQUIRED). It runs from one instant to another (`startsAt`, `endsAt`, with their offset), two weeks at most, a year ahead at most.
- **Who is told:** every active resident and household member of a unit in its buildings.
- **Lead time: 48 hours.** A planned outage is told 48 hours before it starts, by the sweep `maintenance.outage_notices` (every five minutes, each outage FOR UPDATE SKIP LOCKED). An unplanned one, or one starting sooner, is told at creation.
- **Each one told is recorded** (`utility_outage_recipients`, ON CONFLICT DO NOTHING), so everything after goes to exactly those told.
  - A new start is told once to those told (`utility_outage.rescheduled`). New buildings bring an announcement to their residents.
  - The end (`.ended`) and a cancellation (`.cancelled`) go to those told.
- **Moves and closing:** a start moves only before it. An outage is cancelled before it starts, with an `outageCancel` reason, or ended after. Then it never changes (a trigger).
- **The resident's side:** a resident reads the outages told to them that have not ended (`GET /me/outages`).
- **Notices:** they carry the kind and the instants, never the note. They are in a new category, `utilities` (ADR 0036), so a resident chooses how they come, and not critical: quiet hours and a pause still hold them.

## Dates and instants

- **Days** are `*On`, validated `@IsString() @IsLocalDate()`: `installedOn`, `readOn`, `effectiveOn`, `startsOn`, `endedOn`; and `from`/`to` through the period.
- **Instants** are `*At` with their offset (`@ToInstant() @IsDate()`): an outage's start and end.
- **Never input:** when a reading was recorded, superseded, acknowledged, ended or told is the database's clock.

## Lock order (new paths)

1. The caller's account (shared).
2. A reading import, when applying one.
3. The meter (`FOR UPDATE`; an import's in code order).
4. Its live readings, read, never locked.

An outage, an alert and a measure are each locked FOR UPDATE alone. The UPDATE grant is on every table these lock.

## Privacy

- **Audit:** codes, kinds, ids, days, instants, values and prices. An outage's note is recorded as `{ changed: true }`. A reading is a fact, not a decision: only its correction or withdrawal is audited.
- **Notifications:** a meter's code and a day; an outage's kind and its instants.
- **R11c:**
  - A unit's meters and readings belong to the unit, never an account.
  - R11c's resident view will read them only over the resident's occupancy dates.
  - Any comparison a resident sees will be an aggregate over at least five units of the same building and kind (the same rule as a poll's turnout, ADR 0040).

## Consequences

- **Data:** the move step `meters_read` (ADR 0063) can later point at a reading; today it is still ticked by hand.
- **Purposes:** `data_import` sheets are uploaded with `assets.manage` or `energy.manage`.
- **Instants:** an instant shaped right that names no day (`2099-02-30T08:00Z`) passes the instant check, as `Date.parse` rolls it over. That is not this phase's to change; it goes with the dates' fix (ADR 0025).

## Open

- Smart-meter feeds (a vendor).
- A meter's QR tag and scan.
- Leaks (use on days a unit stands empty) and other rules than spikes.
- Bills to residents from their meters (R11c, finance).
- A meter reading that ticks the move step `meters_read` (ADR 0063).
