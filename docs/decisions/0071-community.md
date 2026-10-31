# 0071 — Community: the market (listings, a unit for sale or to let, masked contact, shops, reports), partner and group offers, prayer times, buses, the gallery, busy levels, the visitor's notices and route, the emergency guides and an emergency's place

**Status:** Accepted · R11c-2 · amends ADR 0042 (the masked conversation, generalised), 0043 (closes its open items on `always_allow` and the visitor's route), 0044 (busy levels, never counts), 0047 (an emergency's place), 0060 (partner offers), 0062 (compound document kinds)

## Context

R11c is the last resident phase. R11c-1a (ADR 0069) took the unit and its money, R11c-1b (ADR 0070) the booking extras and the charges; this one is the community the resident lives in: a market between neighbours, offers from the compound's partners and for buying together, daily life (prayer times, buses, a gallery, how busy the gates and facilities are), the visitor's notices and route, and the emergency guides and place. The user's decisions (2026-10-30): prayer times and an emergency place are in; weather, vaccination records and loyalty points are deferred. The plan's open questions were all answered with its recommendations; R11c-2 was started early, in parallel with R11c-1b, on the user's approval (2026-10-31). The user accepted every deviation from the plan recorded here (2026-11-01), among them a listing conversation's report closed `post_removed` taking the listing off, and the `adhan` dependency.

## Decisions

### Where it lives

- **The market is in the neighbours domain** (`src/neighbours/market`), not a domain of its own: it shares the neighbours' masked conversation (one engine, one moderation queue, shared blocks), and nothing imports neighbours (ADR 0042), so a separate domain could not share it without a new boundary.
- **Partner offers and group offers are in the partners domain** (`src/partners/{offers,group-offers}`): a group offer may name a partner, and neighbours may not import partners. Their resident routes are the market's (`/market/offers`, `/market/group-offers`).
- **Daily life is in engagement** (`src/engagement/{prayer,transport,gallery}`); busy levels in facilities and the gate; the visitor's notices and route in the gate; the emergency guides in governance's compound documents.

### Permissions and the notification category

- `market.post` (resident and family): list, open a shop, write to a seller, report a listing. `market.handle` (manager by default; staff may be given it): the review, the reports, the shops, the settings and the group offers. Minors have no account (ADR 0021), so there is nothing to refuse there.
- Partner offers are `partners.manage`; prayer settings, buses and the gallery `content.manage`; reading them `community.read`.
- A new notification category `market` (listings, shops, group offers), so a resident can mute it.

### Listings

- `market_listings`: a kind (`sell`, `give`, `wanted`, `service`, `unit_sale`, `unit_rent`), a category from a closed list (`real_estate` exactly for a unit), a title and a body (the seller's words), a price (DECIMAL; required to sell and for a unit, refused on a gift), `negotiable`, up to six photos (`market_listing_photo`, 5 MB images; a photo row goes only with its deleted file).
- **Its life:** `pending_review` (when the compound reviews, the default) → `live`, or `rejected` with a code; `live` → `under_review` (reported) → `live` again or `removed`; and `withdrawn` (by the seller, or the system: `seller_left`, `seller_erased`, `owner_left`), `sold`, `expired`. Every end is final (trigger); the only change after it is an erasure clearing the words.
- **What every reader sees:** the seller's building, never a name or a unit; `mine` for the seller. A live listing whose day passed reads `expired` at once; the hourly `market.listings` sweep ends it and tells the seller two days before, once.
- **The seller** changes a waiting or live listing (where the compound reviews, a changed live one goes back for review), withdraws it, marks it sold. **The handlers** approve (full days from then), turn down or take off with a code (`marketListingReject`, `marketListingRemove`); the seller is told by kind and code.
- **Settings** (`market_settings`, one a compound): review on by default, ten open listings a seller, thirty days, three reporting units.
- **Search:** `GET /market/listings?q&kind&category&minPrice&maxPrice&sort&cursor` — live only, Postgres text search (`'simple'`, a generated `tsvector` with a GIN index, no extension), newest first or by price (keyset on the price; a price sort reads only priced listings), 30 word searches a minute an account.
- **A unit for sale or to let:** only its owner (an active owner occupancy, living there or not), under the unit's lock, one open a unit and a kind (partial unique). The view shows type, area, building and floor, **never the code**. It ends when the ownership does.

### Masked contact, generalised

- `neighbour_conversations` names a post or a listing, exactly one (CHECK), one a listing and responder. `POST /market/listings/{id}/conversations` runs the post's rules (quota, pair lock, block, daily limit); the listing is read again under FOR SHARE after the pair's lock, so a removal (FOR UPDATE) and a conversation starting are decided one at a time. Reading and writing stay `/neighbour-conversations`, reached with `neighbours.board` or `market.post`. Notices carry `postKind` or `listingKind`, never words.
- A report closed `post_removed` on a listing's conversation takes the listing off (`harassment`).

### Shops and reports

- **A shop** (`market_shops`): names in both languages, a few words, a category, run from one of the owner's units; `pending → active ⇄ suspended`, `closed` for good; one open an account. A handler opens, reinstates, turns down (it closes) or suspends with a code (`marketShopReject`, `marketShopSuspend`). A listing may name its seller's own active shop.
- **A report** (`market_listing_reports`): once a listing and resident, a `marketReport` code and a note for the staff alone. Under the listing's lock, open reports from `report_hide_threshold` distinct units take a live listing to `under_review` once, and the handlers are told. A handler closes each with a `marketReportOutcome`; `removed` takes the listing off for the report's code. The reporter is told it was looked at, never how.

### Partner and group offers

- **A partner offer:** titles and words in both languages, from a day to a day (within a year), withdrawn once; residents read those in force on the compound's day, of partners not suspended.
- **A group offer:** a list and a group price (below it), at least two households, an optional cap, an optional interest phase (a non-binding count — the interest poll) before it opens, a close. Residents join with a quantity (1–10) for one of their units and may leave while it is open; the saving `(list − group) × quantity` is computed on read. The `market.group_offers` sweep opens an ended interest phase and closes an ended offer: confirmed with enough households, else failed; each participant is told. Locks: the account, the offer FOR UPDATE, the participation; the cap is counted under the offer's lock. **No money passes through Jiwar**: buyers pay the partner.

### Daily life

- **Prayer times:** the compound's place (latitude and longitude, both or neither), a calculation method (Egyptian by default) and the school for Asr, set with `content.manage`; `GET /prayer-times?on` and the daily brief give the day's six times as instants, computed on read.
  - **Dependency:** the [`adhan`](https://github.com/batoulapps/adhan-js) package, **version 4.4.3**, **MIT licence**. Why: a well-known, small implementation of the standard astronomical calculation with the recognised methods (Egyptian General Authority among them), so the compound's times match what residents expect, without writing and validating our own solar arithmetic. It computes **locally, in the process, with no network call**: nothing about the compound or its place leaves the server. The day is built from the compound's local date, whatever the server's zone. It is pinned exactly; an upgrade is a reviewed change.
- **Buses:** routes and their departures on weekdays at a local time of day, from a stop to a stop; residents read the timetable and the next departures (today's and tomorrow's on the compound's clock); the brief carries the next three. A timetable, not a record: a departure that no longer runs is deleted.
- **The gallery:** staff-only uploads (`gallery_photo`, 10 MB images) in albums, an event's or not, published once. A resident reports a photo once; **a privacy report hides it at once**, pending the staff, who show it again or keep it hidden with a code. A hidden photo is never shown to a resident. A report and the album's publication are decided one at a time (the album's lock).
- **Busy levels (amends ADR 0044):** three bands, `quiet`, `normal`, `busy`, never a count; no push for expected busy times.
  - A bookable facility's slot: its share of the capacity (below a third quiet, from two thirds busy), counted as the slot is held: bookings, or seats — a party and its companions (ADR 0070). A facility's own read: `busyNow` (held at this instant) and `usuallyBusy` (the mean share at this weekday and hour over the last eight weeks, null with fewer than four). Walk-in facilities have none (no check-in data: walk-in occupancy is deferred). A facility's level is not in the brief: engagement may not import facilities.
  - A gate: its entries in the last fifteen minutes against the compound's thresholds (`gate_settings`, 10 and 30 by default), on `GET /gates/status` and in the brief. Residents' own entries are never logged (ADR 0031).

### Visitors

- **Entry and exit notices:** a pass says whether its host and the unit's `visitorsNotify` holders hear of each entry and exit (`notifyOnEntry`: on by default, off by default on a recurring pass; existing recurring passes were turned off). The pass and the gate only, never the visitor's name; online and from an offline device alike.
- **A standing instruction's opt-in** (`notify`): when the guard lets someone in by an `always_allow` instruction carrying it, the household is told once, the request alone — closing ADR 0043's open item.
- **Re-invite:** `POST /visitor-passes/{id}/reinvite`, for the earlier pass's host: the visitor's details are copied into a new pass with the same kind and party, through every check a new pass runs, while the compound keeps them; read under a shared lock against the retention sweep; gone or past their day, `409 VISITOR_DETAILS_PURGED`.
- **The route before arrival:** a gate's directions in both languages (audited as changed only); a pass may name the gate its visitor is expected at; the visitor's page shows that gate and its directions, and the parking area of the host's visitor parking booking for the pass (ADR 0045) — closing ADR 0043's open item.

### Health

- **Emergency guides:** compound-document kinds `emergency_medical`, `emergency_fire`, `emergency_security`, `emergency_facilities`, never announced; `GET /emergency-guides`, the latest of each published, in a fixed order, with its PDF's presigned read when it has one (as one version's read; no-store).
- **An emergency's place:** a resident away from home reports from one of the compound's common areas (`commonAreaId`): the unit stays the button's, the area tells the responders where to go, with its building; frozen with the report. Still no GPS.

### Privacy and audit

- Audit carries kinds, codes, ids, counts and days; a seller's, a shop's, a reporter's or a caption's words are never in it (`{ changed: true }` where a change is recorded). Notifications carry kinds, codes as `reason`, and a gate's name.
- Personal-data export (ADR 0036): `market/listings.json` (every listing of the account's, in every state, the photos as a count), `market/shops.json` (every shop it opened) and `partners/group-offers.json` (every place it took in a group offer, left ones too, with the offer's title, group price and state); a conversation about a listing is with the neighbours' conversations. A report stays out, as a conversation's report does.
- Erasure: a seller's listings are withdrawn and their words cleared, their photos deleted with their files; a shop closes and its words go; a reporter's notes go. Leaving the compound withdraws listings, closes the shop and leaves live group offers.

## Consequences

- One masked-conversation engine serves the boards and the market; its moderation queue is shared.
- Two new sweeps: `market.listings` (hourly) and `market.group_offers` (every minute).
- A new runtime dependency (`adhan`), local only.
- Races proven 3×: two listings of one unit; a removal against a conversation starting; reports crossing the threshold at once; the last places of a group offer; a join and a leave against the close; a privacy report against the publication; a re-invite against the retention sweep.

## Deferred

- Weather (an outbound API), vaccination records (health data), loyalty points (earning and redemption rules), walk-in occupancy (no check-in data); and from R11c-1: the leak alert and meter-based bills.
