# 0060 — The partner catalogue: the compound's service partners by category, with hours, prices and area; residents' requests answered on a partner's desk link or relayed by the management; the gate's own service pass; ratings, complaints as management requests, suspension with alternatives, and a consent per category

**Status:** Accepted · Phase P1 · Partners

## Context

A compound works with outside businesses that serve its residents: gas and water, a pharmacy, groceries, cleaning, laundry, a gardener, home beauty, repairs, pets, events, moving, cars, and care for the elderly. Until now a resident found them by word of mouth, and the management had no record of who comes in to serve whom, or of what went wrong.

**Out of scope:**
- third-party integrations: a partner has no account, no API and no app;
- money: prices are announced, never charged; no payment moves through the platform;
- a partner's own staff list, or tracking them inside the compound;
- push for new partners.

**The model is the earlier cards':**
- rules are decided under a lock, by the database's clock (`dbNow`);
- rows move forward only, guarded by triggers;
- codes are used instead of free text outside what people write;
- every response is `no-store`;
- every new table is under RLS, forced, with composite foreign keys;
- the audit, notifications, outbox and idempotency records hold ids, codes and counts only.

## Decisions

### Where it lives

A tenth domain, `src/partners`. It reads the other domains through ports, all imported from their `index.ts`:
- **community** (`CommunityPartnersPort`): where the caller lives, the unit's code and building, their capabilities on it, a first name;
- **gate** (`GatePartnersPort`): a service pass issued, cancelled, read;
- **management** (`ManagementPartnersPort`): a complaint opened as a management request, and its number.

Nothing imports partners. The boundaries rule and its spec say so.

### The catalogue

**Categories are a closed list in code**, 13 of them: `gas_water`, `pharmacy`, `grocery`, `home_services`, `laundry`, `gardening`, `beauty_at_home`, `repair`, `pets`, `events`, `moving_storage`, `car_services`, `elderly_care`. Adding one is a code change, with its consent code (below).

**Sub-categories are the compound's** (`partner_subcategories`): a key, English and Arabic names, retired with `active`, never deleted. A default set is provisioned and backfilled (for example `home_services` → cleaning, pest control, air conditioning; `laundry` → laundry, carpets; `elderly_care` → companion, nursing visit). At most 200 per compound.

**A partner** (`partners`, at most 300 per compound) has:
- English and Arabic names, and optional descriptions;
- a business phone (E.164, by CHECK), **the only contact residents see**;
- an optional `notify_email`, which only staff see;
- a service area: buildings (`service_buildings`), empty for the whole compound;
- `home_visit`;
- its services (`partner_services`): a category, and a sub-category of that category or none, held by a composite foreign key; unique with `NULLS NOT DISTINCT`;
- its hours (`partner_hours`): weekly windows in the compound's time zone;
- its price items (`partner_price_items`): names, a price in EGP (`DECIMAL(10,2)`, CHECK ≥ 0) and a unit from `fixed`, `per_visit`, `visit_fee`, `per_hour`, `per_item`, `per_kg`, `per_sqm`. **A paid home service is a price item with the unit `visit_fee`.**

Services, hours and prices are each replaced whole (`PUT`), under the partner's row lock. A partner is never deleted.

**Open now and open late** are pure functions in `core/common/slots/weekly-windows.ts`:
- `openAt`: whether a window holds the instant, in the zone; a window ending at 24:00 and one starting at 00:00 the next day join across midnight;
- `openLateTonight`: whether the partner is open at some point today after `max(now, late_from_minute)` (22:00 by default).

They are tested across a DST change.

**New**: listed within `new_days` (30).

### The compound's settings

`partner_settings`, one row per compound (provisioned and backfilled), changed by `partners.manage` and audited by value. The CHECK `partner_settings_ranges` pins the ranges:

| Setting | Default | Range |
|---|---|---|
| `new_days` | 30 | 1–90 |
| `late_from_minute` | 1320 (22:00) | 960–1439 |
| `max_live_requests` | 5 | 1–20 |
| `rating_days` | 14 | 1–60 |
| `complaint_days` | 14 | 1–60 |
| `desk_link_days` | 90 | 7–365 |

### Discovery and favourites

- `GET /partners`, with `category`, `subcategoryId`, `openNow`, `openLate`, `new`, `favourites`: the compound's active partners. Each shows `openNow`, `openLateTonight`, `isNew`, `favourite` and the rating summary.
- `GET /partners/{id}`: one partner. **A suspended partner** is never listed, but is still read by its id (those told of the suspension open it), with `status: suspended` and `alternatives`. The reason is never shown.
- **Alternatives** (`rankAlternatives`, computed at read time): up to three active partners sharing a category, open now first, then by rating, then the newest.
- Favourites (`partner_favourites`, the account and the partner): at most 50, counted under the account's advisory lock.

### Consent per category (amends ADR 0036)

A request shows a partner a little of the resident. ADR 0036 left partner consents "out of R1"; this adds them:
- 13 catalogue codes, `partner_share_<category>`, at version 1. Both consent CHECKs are recreated with them.
- **Asking** needs the category's code granted at its current version, else `409 CONSENT_REQUIRED` with `params.code`.
- **The partner's side reads the consent at read time.** Once withdrawn, the desk and the relay see the request's status and window only: `consentWithdrawn: true`, and the unit's code, the first name, the note, the lines and the pass are null. Every partner-side action answers `409 PARTNER_REQUEST_CONSENT_WITHDRAWN`. The resident may still cancel.
- **What a partner ever sees:** the unit's code, a first name, the window, the note and the price lines. Never a phone, a full name or an account id.

### Requests

`partner_requests`, numbered `SR-000123` from `partner_request_counters`, last in the transaction.

**Who may ask** (amends ADR 0021 for partners): `partners.request` (residents and family), for a unit the caller lives in, **and only if the caller may invite visitors there** (`visitorsInvite`). A member without the grant, and minor mode, get `403 PARTNER_REQUEST_NOT_ALLOWED`. A partner comes in through the gate as a visitor would, so asking one is inviting one.

**What a request holds:**
- the partner, a category it offers, and optionally a sub-category it offers there;
- a window: starting 15 minutes to 14 days ahead, 30 minutes to 8 hours long;
- a note (1–500 characters), optional;
- up to 10 price lines, each a price item of the partner with a quantity: names, price and unit are **copied** at the time, and never change;
- `gatePass`: whether the partner needs a pass.

**Refused:** a suspended partner (`PARTNER_SUSPENDED`); a unit outside its area (`PARTNER_OUT_OF_AREA`); more than `max_live_requests` open for the account (`PARTNER_REQUEST_LIMIT_REACHED`, counted under the account's advisory lock).

**Statuses**, one state machine (`request-rules.ts`, pure):

| From | Action | To |
|---|---|---|
| `pending` | the partner accepts | `accepted` |
| `pending` | the partner declines (`partnerRequestDecline`) | `declined` |
| `pending` | the partner proposes another window | `proposed` |
| `proposed` | the resident accepts it | `accepted` |
| `proposed` | the resident declines it | `cancelled` (`proposal_declined`) |
| `pending`, `proposed`, `accepted` | the resident cancels (`partnerRequestResidentCancel`) | `cancelled` |
| `accepted` | the partner cancels, before the window ends (`partnerRequestPartnerCancel`) | `cancelled` |
| `accepted` | either side, once the window has started | `done` |
| `accepted` | the resident, once the window has ended | `partner_no_show` |
| `pending`, `proposed` | the system, once the window has started (`partners.expire_requests`, every minute) | `expired` |
| `accepted` | the system, seven days after the window (`partners.lapse_requests`, hourly) | `lapsed` |
| live | the system (`partnerRequestSystemCancel`: `partner_suspended`, `requester_left`) | `cancelled` |

- The partner accepts or proposes before the window starts; accepting may set `staffCount` (1–5, the pass's party size).
- A trigger keeps what the request asked, moves it forward only, and sets each stamp once. Nothing is deleted.
- **History:** `partner_request_events`, append-only by trigger. Each step has its kind, the side (`resident`, `partner_desk`, `relay`, `system`), a reason code and a window. Also `pass_issued`, `pass_skipped` and `pass_cancelled`.
- **One engine** (`PartnerRequestEngine`) applies every action: the row, the event, the audit and the notices, then the gate's hooks. Repeating an action that already took effect answers the request as it is; any other move from the wrong status is `409 PARTNER_REQUEST_INVALID_TRANSITION` with `params.status`.

### The partner's desk link

A partner has no account. It answers on **its desk**: a page opened from a link the management gives it.

- **The token:** 32 random bytes, base64url. Stored only as `SHA-256("jiwar:partner-desk:v1:" + token)` in `partner_desk_links`, a global pointer table (on the RLS allowlist, with the tenant in the row), so a lookup finds the compound first.
- **One live link per partner** (partial unique). Creating one revokes the last (rotation); revoking leaves none. The token is shown once, in the create's response, as `/p#<token>`: the same model as the visitor page `/v#`. No new env key.
- **It expires** `desk_link_days` after it was made (`expires_at`, stored). It must be rotated before then; the manager sees the expiry.
- **Every link that does not open a desk answers the same `404 PARTNER_DESK_NOT_FOUND`**: unknown, malformed, revoked, expired, a suspended partner's, or a suspended compound's. The enumeration test holds it.
- **Public routes**, all `POST` with the token in the body, `@PublicPageHeaders` (no-store, no referrer, no index), rate-limited per IP (60 a minute) and per token (30 a minute):
  - `/public/partner-desk/lookup`: the compound's name and zone, the partner, and its requests that are live or closed in the last 24 hours (at most 100);
  - `/public/partner-desk/requests/{id}/accept|decline|propose|done|cancel`.
- The desk service is on the `runInTenantUnsafe` allowlist: it resolves the tenant from the link.
- **Audit:** each lookup is `partner_desk.looked_up` with the link's id and the count of requests shown; each action is the request's own entry with the system as actor and `via: partner_desk` and the link's id. Never the token, never a hash of it.
- **The partner's alert:** a new request emails `notify_email` (template `partner_desk.new_request`): the compound's name and the category only, no PII and no link. A partner with no live link alerts the `partners.manage` holders instead (`partner_request.awaiting_relay`).

### The management's relay

For a partner that answers by phone, or not at all: `/staff/partner-requests` (`partners.manage`) lists the compound's requests and takes the same five actions as the desk, recorded with the side `relay` and the staff account. It sees what the desk sees, and the partner.

### The gate's service pass (amends ADR 0028 and 0043)

When a request with `gatePass` is accepted, the gate issues **a one-time visitor pass of its own kind**, through `GatePartnersPort.issueServicePass`:
- host: the requester; unit: the request's;
- window: from `max(now, start − 30 min)` to `end + 60 min`;
- party size: `staffCount` (1 by default);
- visitor name: the partner's Arabic name.

`VisitorPassesService.createIn` is split (`insertPass`, `roomFor`) so the service path and the session path share the rules; the session path is unchanged. **There is no new gate logic:** the guard checks it as any pass.

- **No pass is made, and the accept still stands,** when the host may no longer invite visitors (`host_cannot_invite`) or the unit's live passes are at the cap (`pass_limit`). The history records `pass_skipped` with the code. The guard raises the usual approval request at the gate.
- **On cancel or suspension** the pass is cancelled through the port, with a new cancel reason `service_cancelled` (`pass_cancelled`).
- `partner_requests.pass_id` points at the pass by a composite foreign key, unique.
- **The desk shows the pass** (its code, link and QR payload, ADR 0043's derived secret) **only from two hours before the agreed window starts until it ends**, while consent holds and the pass is active. The resident's view carries `passId`, and the resident's app shows the pass as its own.

### Ratings

`partner_ratings`, keyed by the request:
- the requester rates a `done` request once, within `rating_days` of done: 1–5 stars and an optional comment (≤ 500);
- a trigger keeps the stars, and lets the comment be cleared once, by erasure only;
- residents see `{ average, count }` only once the count is at least 3, read in one grouped query;
- staff read comments (`/staff/partner-ratings`); partners never see a rating.

### Complaints, as management requests (amends ADR 0039)

`POST /partner-requests/{id}/complaint` (an `Idempotency-Key`), by the requester, within `complaint_days` of the request's end, for a request `done`, `partner_no_show`, `lapsed` or cancelled by the partner. It takes:
- a reason (`partnerComplaint`);
- a compensation ask (`partnerCompensationAsk`), with an optional amount when the ask is a refund or damages;
- a message, which becomes the management request's first message.

In one transaction: the account `FOR SHARE`, the request `FOR UPDATE`, then a **management request on the system topic `partner_service`** (`ManagementPartnersPort.openComplaint`), and a `partner_complaints` row linking both, unique per request.

- **The system topic** is in management's defaults (`SYSTEM_TOPICS`), provisioned and backfilled. It is hidden from the residents' topic list and refused in a resident's create: it opens only this way. Its conversation, SLA, escalation and satisfaction are the management request's, unchanged.
- **The decision**, once (trigger), by `partners.manage` (`POST /staff/partner-complaints/{id}/decide`): `upheld` or `not_upheld`, and a compensation from `partnerCompensationDecision` (`none`, `redo`, `partner_refund`, `credit_note`). Not upheld means `none`. The requester is told (`partner_complaint.decided`).
- **`credit_note` is a record, not money.** The manager issues it in finance by its own route. No money moves here.

### Suspension and reinstatement

`POST /staff/partners/{id}/suspend` with a code from `partnerSuspend` (`quality_complaints`, `licence_issue`, `contract_ended`, `partner_request`, `safety`, `other`):
- the accounts concerned (requesters of live requests, favouriters) are locked `FOR KEY SHARE` first, `SKIP LOCKED` for any that came later; then the partner `FOR UPDATE`;
- every live request is cancelled by the system (`partner_suspended`), with its pass;
- the requesters and the favouriters are told once each (`partner.suspended`, target the partner): its page shows the alternatives, never the reason;
- the desk link stops answering, as an unknown one.

Reinstating (`…/reinstate`) tells nobody and brings no request back. A request asked at the same moment is either refused (`PARTNER_SUSPENDED`) or cancelled: never left live.

### Locks

One order everywhere: **the accounts → the account's advisory quota lock → the partner's row → the settings → the request's row → the gate (its unit lock, the pass).** The desk reads the partner without a lock before the action takes the order. No path locks a unit's row.

Tested races: two accepts at once (one acceptance, one pass); accept against the resident's cancel (one wins, no orphan pass); suspension against a new request; two complaints, two ratings and the favourites cap at once.

### Permissions and roles

| Permission | Who holds it |
|---|---|
| `partners.request` | residents and family (and the unit's `visitorsInvite`, above) |
| `partners.manage` | staff or manager; the manager role |

`pnpm access:sync` brings existing compounds the grants. The dashboard admits a staff role that holds only `partners.manage`.

### Notifications

A new category, `partners`. No kind is critical. Params are codes only: never the partner's name, a time or a unit.

| Kind | Who is told |
|---|---|
| `partner_request.accepted`, `.declined` (`reason`), `.proposed`, `.done` | the requester, of the partner's move |
| `partner_request.cancelled` (`side`, `reason`) | the requester, when the partner cancels |
| `partner_request.expired` | the requester |
| `partner_request.awaiting_relay` (`category`) | the `partners.manage` holders, for a partner with no desk link |
| `partner_complaint.decided` (`outcome`, `compensation`) | the requester |
| `partner.suspended` | the requesters of live requests and the favouriters |

The resident's own moves tell nobody. Each kind has its English and Arabic push text, generic.

### Privacy and audit

- **Audit rows** carry ids, codes, statuses, windows, counts and booleans. A name, a description, a phone, an email, a note or a comment appears only as `{ changed: true }` or a boolean.
- **A requester who goes** (erased, deactivated, or no longer in the unit): their live requests are cancelled by the system (`requester_left`), passes too, and nobody is told.
- **Erased:** their notes and rating comments are cleared, once, and their favourites deleted.
- **Export** (`partners/requests.json`, `partners/favourites.json`): the account's own requests with what it wrote, its ratings and complaints, and its favourites. Never the staff's handling or the desk's.

## Consequences

**Migrations** (`20261112090000` to `20261112090500`):
- `090000`: the enum value `partners` (notification category) alone;
- `090100`: the settings, sub-categories (seeded), partners, services, hours, price items, favourites;
- `090200`: both consent CHECKs, recreated with the 13 codes;
- `090300`: the counters, requests, items, events, and the global desk links;
- `090400`: the requests' `pass_id` and the gate's `service_cancelled`; the requests' trigger replaced;
- `090500`: the ratings, the complaints, and the backfilled `partner_service` topic.

**Thirteen new tenant tables**, each under RLS, forced, with the UPDATE grant where they are locked; **one global table** on the allowlist. Every new CHECK is in the CHECK map. Triggers guard the requests, their items and events, ratings, complaints' decisions and desk links.

**This amends:**
- **ADR 0058:** a `partner_request` source in the resident's lists: `GET /me/requests` (the caller's own, `kind` the category) and `/me/search` (by `SR-` reference or the partner's name); the office's open-now status moves to core beside `openAt` (`weeklyStatus`), unchanged;
- **ADR 0021:** asking a partner needs the unit's `visitorsInvite`;
- **ADR 0028 and 0043:** a service pass issued for a host by the system, and its cancel reason; no new gate rule;
- **ADR 0036:** 13 partner consents, a new delivery category `partners`, a `partners` export section;
- **ADR 0039:** a system topic residents cannot pick, opened by another domain. It sits beside ADR 0058's `release_request`, which residents do pick.

**The manager dashboard gains** Partners (the catalogue, one partner with its services, hours, prices, area, desk link shown once, suspend and reinstate), Partner requests (the relay), Partner complaints (the decision) and Partner settings. **`apps/public` gains `/p#<token>`**, the partner's desk.

## Deviations from the request

- **Prices are EGP in `DECIMAL(10,2)`**, as finance stores money, not integer piastres.
- **The desk's actor is the system,** with `via: partner_desk` and the link's id in the audit: a partner has no account to name.
- **Minor mode** cannot be a request's caller: a minor holds no account, so holds nothing (ADR 0021). The capability rule is unit-tested, and the e2e tests a member without `visitorsInvite` and one with it.
- **Creating a desk link takes no `Idempotency-Key`:** its token is random and shown once, and a retry is a rotation.
- **Gate pass cancel reasons have no CHECK** to recreate; the reason is a code in the gate's list.

## Open

- **No live channel.** The desk and the dashboard refresh on demand; the partner's email and the residents' pushes tell.
- **A partner with many compounds** has one desk per compound.
