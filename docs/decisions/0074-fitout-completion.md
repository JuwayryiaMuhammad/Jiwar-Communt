# 0074 — Fit-out completion: a works permit's deposit, drawings, debris removals, the common areas before and after, damage claims, and a certificate that waits for them

**Status:** Accepted · M2-8 · amends ADR 0049 (works permits), 0053 (violations on a permit), 0059 (an overturned rejection), 0062 (finishing-works deposits), 0063 (the completion certificate), 0070 (the charges port)

## Context

The manager's audit (2026-11-01, `manager-gap.md`, part 02 "المقاولون والتشطيب") found the fit-out half done. Works permits, their contractors and the stop of work exist (ADR 0049, 0053); a finishing-works deposit exists (ADR 0062) and reads the works' completion (ADR 0063). Missing:
- the deposit tied to the permit, and asked for before the works;
- the debris to take out, scheduled and checked;
- the common areas recorded before and after the works;
- a damage claim, settled from the deposit or, past it, as the unit's;
- the certificate refused while violations or claims are open;
- the works' drawings.

The owner accepted the plan (M2-8 in `manager-plan.md`) and the audit's recommendations on 2026-11-01: the deposit rule is the compound's, on by default (decision 4); a claim larger than the deposit, or with none, is charged to the unit, with one appeal as a violation has (decision 5); open violations and open claims both block the certificate (decision 6). On 2026-11-02 the owner settled how the rule reaches the compounds that already exist: off for them, on for compounds created afterwards.

## Decisions

### Where it lives

`src/gate/permits/fitout/`, in the gate domain with the permits. Finance keeps the deposits; the two meet through core's **`WorksDeposits`** port (`src/core/works/works-deposits.ts`), as ADR 0063's `WorksCompletions` does the other way round:
- finance implements `ofPermits` (the deposit named on each permit, with what it holds, FOR SHARE on demand) and `deductForClaim` (a `damage` deduction, as far as it holds);
- the gate registers `unitOf` (a works permit's unit) and `openClaims` (its claims not settled or withdrawn).

A missing side stops the start.

### The works deposit

- A finishing-works deposit (`POST /staff/deposits`) may name the works permit it is held for: `permitId`.
  - The permit must be a works permit of the deposit's unit, one deposit per permit.
  - Two composite keys hold it: the permit's kind (always works) and the permit's unit. A CHECK keeps a named permit to the finishing-works kind.
  - Recorded under the unit's finance lock, so two deposits for one permit wait for each other and the second is refused (`DUPLICATE_VALUE`).
- The compound's permit rules gain **`worksDepositRequired`**: on by default for a compound created from now on (the column's default), off for every compound that exists when the migration runs (a per-tenant backfill writes false; the owner, 2026-11-02). The management turns it on or off in the permit settings.
  - On: approving works reads the deposit named on the permit FOR SHARE, after the permit's row, and refuses `PERMIT_DEPOSIT_REQUIRED` (params.deposit: its number, or null) while it holds nothing.
  - An overturned rejection (ADR 0059) is left to the management as `deposit_required`, a new follow-up reason.
- A refund of that deposit waits while a damage claim on the permit is open: `DEPOSIT_CLAIM_OPEN` (params.claims). Deductions and forfeits do not wait.

### The fit-out

`GET /permits/{id}/fit-out` (the household: the permit's requester, or the unit's primary now) and `GET /staff/unit-permits/{id}/fit-out` (`permits.manage`) show:
- the deposit named on the permit;
- whether the compound asks for one;
- the drawings, debris removals, the areas before and after, and the claims;
- `certificateBlockedBy`.

Any other permit, or one the caller has no part in, is the one not-found.

Every write takes the permits' lock order (ADR 0049): the caller's account (FOR SHARE), the unit's advisory lock, the permit's row (FOR UPDATE), then the fit-out's own rows, a file's row, and last a number.

### Drawings

- The household joins `permit_drawing` files (an image or a PDF, 10 MB) while the permit is pending, or approved and not ended. At most ten at once (`PERMIT_DRAWING_LIMIT`).
- It takes one off, once. The file stays the record's.

### Debris removals

- The household or the management schedules a window on an approved works permit that has not ended:
  - a local day of its period that is a work day of the compound, inside its hours;
  - 30 minutes to four hours, starting ahead;
  - three scheduled at once at most, never overlapping.
- The management, or a guard on shift, marks one done from half an hour before its window. A guard's shift is locked FOR SHARE first (ADR 0056: the account, then the shift).
- The `permits.debris_missed` sweep marks missed one nobody marked two hours past its end, under the permit's unit lock and row, judged again. It tells the requester and whoever manages permits (`unit_permit.debris_missed`).
- Whoever scheduled it (their side), or the management, calls one off before it starts, with a code (`debrisSlotCancel`).
- The gate lists a permit's removals of today: `GET /gate/unit-permits/{id}/debris-slots`.

### The common areas before and after

- The management records an active common area before the works (while the permit is open) and, once that is recorded, after them (on an approved permit): one to ten `fitout_photo` files and a note the household reads.
- One record per area and stage. A record never changes: it is the evidence a claim stands on.

### Damage claims (`DC-`)

- **Raised:** by the management on an approved or revoked works permit, under the permit's row and the unit's finance lock.
  - It carries a code (`damageClaim`), words the household reads, an amount in EGP (at most a million), an optional common area and one to six photos.
  - Numbers are the compound's, under an advisory lock taken last.
  - The requester and the unit's primary are told (`unit_permit.damage_claimed`).
- **Appealed:** either of them appeals it once, within 14 days, while it is open: words and an optional `damage_appeal_photo`. Whoever manages permits is told.
  - The management upholds the claim (open again) or accepts the appeal (withdrawn, `appeal_accepted`). The appellant is told.
- **Withdrawn:** an open claim not under appeal, by the management, with a code (`damageClaimWithdraw`, but `appeal_accepted`).
- **Settled:** once, with a fresh step-up, when its appeal was decided or its 14 days passed (`DAMAGE_CLAIM_APPEAL_WINDOW`).
  - Finance takes a `damage` deduction from the deposit named on the permit, as far as it holds.
  - The rest is owed as a **`damage` invoice** of the unit's through the charges port (a new source, `damage_claim`, and kind), due in 14 local days.
  - The claim keeps both parts, which add up to the amount (a CHECK).
- **Lock order:** the fit-out's, then the unit's finance lock (a deposit's refund takes it too), the claim's row, the deposit's row.
- A trigger keeps the terms and moves the status forward once each way.

### The certificate waits

- A pass of a completion inspection takes the permit's row FOR UPDATE after the unit's lock, and counts:
  - the permit's violations still open or under appeal;
  - its claims not settled or withdrawn.
- Either refuses it: `WORKS_CERTIFICATE_BLOCKED`, with params.violations and params.claims.
- A violation issued on a works permit now takes the permit's row FOR SHARE, so it waits for a pass in flight or is counted by it.

### Privacy and audit

- Audit metadata holds ids, codes, days, counts and amounts. Never anyone's words.
  - The entries are `permit_drawing.*`, `debris_slot.*`, `area_record.recorded` and `damage_claim.*`.
  - `deposit.recorded` gains `permitId`; a claim's deduction is a `deposit.settled` with its `claimId`.
- An appellant's erasure clears their appeal's words and photo (`damage_claim.appeal_cleared`); the claim stays.
- The permits' export section gains `permits/fit-out.json`:
  - the claims on the account's works permits, with its own appeal words while they last;
  - the removals it scheduled;
  - how many drawings it joined.
- Every route is `no-store`. Every new table is under forced RLS with composite keys.

## Consequences

- An existing compound's works are approved as before until its management turns the rule on; a new compound's works wait for their deposit unless it turns the rule off.
- The manager's permit page shows the fit-out and its actions. The permit settings hold the rule.
- The charges port's sources and invoice kinds grow by one. The invoice views show `damage` as one of the port's.
- New files: purposes `permit_drawing`, `fitout_photo`, `damage_appeal_photo`; the files' CHECKs recreated whole.

## Deviations from the approved plan (accepted by the owner, 2026-11-02)

1. **The deposit is asked for at approval, not at each entry.** The gate's offline path cannot read finance, and the audit allowed either. A refund later does not stop works already approved.
2. **A damage claim's settlement asks `permits.manage` and a fresh step-up, not `finance.refund`.** It retains money held for the very works; it moves none out.
3. **A claim's appeal is decided by the management, not taken on to the board** (a violation's upheld appeal may be, ADR 0055). "One appeal like violations" was read as the one appeal.
4. **14 days to appeal a claim**, not a violation's 30: the works' end and the deposit's release should not wait a month.
5. **Debris removals are scheduled on an approved permit only**, and done at the gate by any guard on shift (the gate's routes check `gate.operate`).
6. **A deposit's `worksCompletion` (ADR 0063) still reads any works permit of the unit**, not only the one the deposit names: unchanged here, to leave fix-small-1101's change to that reader alone.

## Deferred

- Scheduling debris by the contractor's own account: the contractor portal, M2-7.
- A claim against the contractor's company rather than the unit: the vendor register, M2-5.
