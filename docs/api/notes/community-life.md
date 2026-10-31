# Community life: backend notes for the mobile team

What was built for the community the resident lives in:
- the market: listings to sell, give, want or offer a service, a unit for sale or to let, masked contact with the seller, shops, reports;
- the compound's partner offers, and group offers for buying together;
- prayer times, the buses, the gallery, and how busy the gates and facilities are;
- the visitor's entry and exit notices, a standing instruction's notice, a re-invite and the visitor's route before arrival;
- the emergency guides, and an emergency reported from a common area.

The design decisions are in [ADR 0071](../../decisions/0071-community.md). The contract is `docs/api/openapi.v0.json` (regenerated), with the Postman collection.

Conventions, as everywhere in API v0:

- Every path is under `/api/v1`, with `Authorization: Bearer <access token>`.
- Lists are `{ "data": [...], "nextCursor": string | null }`.
- Errors are `{ "statusCode", "code", "message", "params"?, "fields"?: [{ "field", "code", "params"? }], "requestId", ... }`. Switch on `code` and `fields[].code`, never on `message`.
- Creates take an optional `Idempotency-Key` header (a UUID).
- Money is an EGP string with two decimals (`"1250.00"`).
- Days are `YYYY-MM-DD`, the compound's; instants ISO 8601 with an offset; a time of day `HH:mm`, the compound's.
- Reason codes come from `GET /reasons` (the lists named below); show their labels, never the code.

## Contents

1. [Permissions and the notification category](#permissions-and-the-notification-category)
2. [Listings](#listings)
3. [A unit for sale or to let](#a-unit-for-sale-or-to-let)
4. [Writing to a seller](#writing-to-a-seller)
5. [Shops](#shops)
6. [Reporting a listing](#reporting-a-listing)
7. [Partner offers](#partner-offers)
8. [Group offers](#group-offers)
9. [Prayer times](#prayer-times)
10. [Buses](#buses)
11. [The gallery](#the-gallery)
12. [Busy levels](#busy-levels)
13. [Visitors](#visitors)
14. [Health](#health)
15. [Your data](#your-data)
16. [Notifications](#notifications)
17. [Errors](#errors)

## Permissions and the notification category

- `market.post` in `GET /me`'s `permissions`: residents and family members. Without it, hide the market; reading it needs the permission too.
- The handlers' routes (`/market/review`, `/market/reports`, `/market/shop-review`, `/market/settings`) are the manager dashboard's (`market.handle`), not the app's.
- A new notification category `market`: listings, shops and group offers. It appears in the preferences like the others, and can be muted.

## Listings

- `POST /market/listings` `{ kind, category, title, body, price?, negotiable?, photoFileIds?, shopId?, unitId?, fromUnitId? }`.
  - `kind`: `sell`, `give`, `wanted`, `service`, `unit_sale`, `unit_rent`. `category` from a closed list (the field's `INVALID_VALUE` lists them); `real_estate` exactly for a unit.
  - `price` is required to sell and for a unit, refused on a gift.
  - Up to six photos: upload each first with purpose `market_listing_photo` (images, 5 MB), then pass their ids in order.
  - `shopId`: your own active shop, if you have one. `fromUnitId`: which of your units to list from when you have several (only its building shows); not for a unit listing.
  - It runs for the compound's number of days from going live (`expiresAt`).
  - Where the compound reviews (the default), the listing starts `pending_review`; otherwise `live`. Over the compound's limit of open listings, `409 MARKET_LISTING_LIMIT_REACHED {max}`.
- `GET /market/listings?q&kind&category&minPrice&maxPrice&sort&cursor`: live listings only. `q` is a word search (at most 30 a minute; over it `429`). `sort`: `newest` (default), `price_asc`, `price_desc`; a price sort leaves out unpriced listings.
- `GET /market/listings/{id}`; `GET /me/market/listings` (your own, every state).
- **What a listing shows:** `title`, `body`, `price`, `negotiable`, `photos` (signed URLs), `seller { building, mine }` — never a name or a unit — `state`, `shopId`, `unit` (a unit listing only), `expiresAt`. A live listing whose time passed reads `expired`. Your own (`/me/market/listings`) add `reasonCode` and `endedAt`.
- `PATCH /market/listings/{id}` while it waits or is live (where the compound reviews, a changed live listing goes back to `pending_review`); `POST …/withdraw`; `POST …/sold`. An ended listing is `409 MARKET_LISTING_ENDED`.
- **States:** `pending_review`, `live`, `under_review` (reported, hidden from the list), `rejected`, `removed` (both with a `reasonCode`), `withdrawn`, `sold`, `expired`. Every end is final.
- The seller hears `market_listing.approved`, `.rejected {reason}`, `.removed {reason}`, and `.expiring` within two days of the end, once.

## A unit for sale or to let

- `kind: unit_sale` or `unit_rent` with `unitId`: only the unit's owner (living there or not); otherwise `403 MARKET_UNIT_NOT_OWNED`. One open listing a unit and a kind: `409 MARKET_UNIT_LISTED`.
- The listing's `unit { type, areaSqm, building, floor }` — **never its code**.
- It is withdrawn by the system when the ownership ends.

## Writing to a seller

- `POST /market/listings/{id}/conversations` `{ body }` starts a masked conversation with the seller, as for a board post; then it is an ordinary `/neighbour-conversations/{id}` thread (read, reply, report, block), reachable with `marketPost` alone.
- Your own listing, or one not live: `409 MARKET_LISTING_NO_CONTACT`. A block, the daily limit and the quota answer as on the boards.
- The conversation's view carries `listing { id, kind, state, … }` in place of `post` (one of them is null); its notices carry `listingKind` in place of `postKind`.

## Shops

- `POST /market/shops` `{ nameEn, nameAr, description, category, fromUnitId? }`: run from one of your units (only its building shows); it starts `pending`. One open shop an account: `409 MARKET_SHOP_EXISTS`.
- `GET /market/shops`, `GET /market/shops/{id}` (active shops: names, words, category, building, `liveListings`); `GET /me/market/shop` (yours, any state, with its `reasonCode`); `POST /me/market/shop/close` (for good).
- States: `pending` → `active` ⇄ `suspended`; `closed`. The owner hears `market_shop.approved`, `.rejected {reason}`, `.suspended {reason}`.

## Reporting a listing

- `POST /market/listings/{id}/report` `{ reasonCode, note? }`: `reasonCode` from `marketReport`; the note is for the staff alone. Once a listing and resident (`409 MARKET_REPORT_EXISTS`); never your own (`409 MARKET_REPORT_OWN_LISTING`).
- Reports from enough households hide a live listing for review.
- The reporter hears `market_report.closed` — that it was looked at, never the outcome.

## Partner offers

- `GET /market/offers`: the compound's partners' offers in force today — `titleEn/Ar`, `bodyEn/Ar`, `partnerId`, `partnerNameEn/Ar`, `validFromOn`, `validToOn`. Read only; there is nothing to redeem in the app.

## Group offers

- `GET /market/group-offers`, `GET /market/group-offers/{id}`: `titleEn/Ar`, `bodyEn/Ar`, `listPrice`, `groupPrice`, `minParticipants`, `maxParticipants` (households, or null), `interestClosesAt`, `closesAt`, `status` (`interest`, `open`, `confirmed`, `failed`, `cancelled`, with `cancelReason`), `interested`, `joined` (households), `quantity` (in all), and yours: `myInterest`, `myQuantity`, `mySaving` (`(list − group) × quantity`, a money string).
- `POST …/interest` `{ unitId }` while in its interest phase (a non-binding count).
- `POST …/join` `{ unitId, quantity }` (1–10) while open; `POST …/leave` while open. Errors: `409 GROUP_OFFER_PHASE`, `GROUP_OFFER_FULL`, `GROUP_OFFER_JOINED`, `GROUP_OFFER_NOT_JOINED`.
- Participants hear `group_offer.opened`, `.confirmed`, `.failed`, `.cancelled {reason}`.
- **No money passes through Jiwar**: a confirmed offer is paid to the partner directly. Say so in the app.

## Prayer times

- `GET /prayer-times?on=YYYY-MM-DD` (today by default): `{ on, timeZone, fajr, sunrise, dhuhr, asr, maghrib, isha }`, instants. Before the management sets the compound's place, `409 PRAYER_PLACE_NOT_SET` — hide the card.
- `GET /me/daily-brief` gains `prayer` (today's, or null).
- The times are computed on the server, for the compound's place and method; the app needs no location.

## Buses

- `GET /buses`: `routes` (active ones: `nameEn/Ar`, `departures [{ weekdays, time (HH:mm), fromStop, toStop }]`) and `next` (`[{ routeId, routeNameEn/Ar, departureId, at, fromStop, toStop }]`: today's and tomorrow's still to come, up to twenty).
- `GET /me/daily-brief` gains `buses`: the next three.

## The gallery

- `GET /gallery/albums`, `GET /gallery/albums/{id}`: published albums and their photos (an event's, when named). A hidden photo is never listed.
- `POST /gallery/photos/{id}/report` `{ reasonCode }` from `galleryPhotoReport`: once a photo (`409 GALLERY_REPORT_EXISTS`). **A `privacy` report hides the photo at once**; tell the resident so.

## Busy levels

- Always one of `quiet`, `normal`, `busy` — never a count.
- A bookable facility's slots carry `busy`; a facility's read carries `busyNow` and `usuallyBusy` (null until there are four weeks of history). Walk-in facilities have neither (null).
- `GET /gates/status` gains each gate's `busy`; `GET /me/daily-brief`'s `gates` carry it too.

## Visitors

- **Entry and exit notices.** A pass's `notifyOnEntry` (on by default; off by default on a recurring pass): the host and the unit's members with `visitorsNotify` hear `visitor_pass.entered` / `.exited {gateName}` — the pass and the gate, never the visitor's name. The pass's detail (`GET /visitor-passes/{id}`) shows it.
- **A standing instruction's notice.** `notify` on an `always_allow` instruction: the household hears `gate.let_in_by_instruction` once when the guard lets someone in by it — the request alone, never the visitor nor the instruction's words.
- **Re-invite.** `POST /visitor-passes/{id}/reinvite` `{ validFrom, validUntil, schedule? }` (`schedule` for a recurring pass) on a pass you hosted: a new pass with the same visitor and party, through every check a new pass runs. Once the compound no longer keeps the visitor's details, `409 VISITOR_DETAILS_PURGED` — offer a new pass instead.
- **The route before arrival.** A pass may name `expectedGateId` (from `GET /gates`). The visitor's page then shows `expectedGate { name, directionsEn, directionsAr }`, and `parkingArea` when the host booked visitor parking for the pass.

## Health

- `GET /emergency-guides`: the compound's guides — `emergency_medical`, `emergency_fire`, `emergency_security`, `emergency_facilities` — the latest published of each, in that order: the text in both languages, and `fileUrl`, a presigned read of its PDF when it has one (`hasFile`; no-store, short-lived). Keep the text for offline; fetch the PDF again when needed.
- `POST /emergencies` gains `commonAreaId?` (from the compound's common areas): reporting away from home; the responders see the area and its building. An area that is not the compound's or not active: `404 COMMON_AREA_NOT_FOUND`. Still no location from the phone.

## Your data

The personal-data export (`/me/data-exports`) gains `market/listings.json` (your listings, every state, the photos as a count), `market/shops.json` (every shop you opened) and `partners/group-offers.json` (every place you took in a group offer, left ones too). A conversation about a listing is with your neighbours' conversations.

## Notifications

| Kind | Params | Who |
| --- | --- | --- |
| `market_listing.approved` | — | the seller |
| `market_listing.rejected`, `.removed` | `reason` | the seller |
| `market_listing.expiring` | — | the seller |
| `market_report.closed` | — | the reporter |
| `market_shop.approved` | — | the shop's owner |
| `market_shop.rejected`, `.suspended` | `reason` | the shop's owner |
| `group_offer.opened`, `.confirmed`, `.failed` | — | the participants |
| `group_offer.cancelled` | `reason` | the participants |
| `visitor_pass.entered`, `.exited` | `gateName` | the host, `visitorsNotify` holders |
| `gate.let_in_by_instruction` | — (the request) | the household's `visitorsNotify` holders |

`market_listing.under_review` and `gallery_photo.reported` go to the staff only.

## Errors

`MARKET_LISTING_NOT_FOUND`, `MARKET_LISTING_ENDED`, `MARKET_LISTING_LIMIT_REACHED {max}`, `MARKET_LISTING_NO_CONTACT`, `MARKET_UNIT_NOT_OWNED`, `MARKET_UNIT_LISTED`, `MARKET_SHOP_NOT_FOUND`, `MARKET_SHOP_EXISTS`, `MARKET_SHOP_STATE`, `MARKET_REPORT_EXISTS`, `MARKET_REPORT_OWN_LISTING`, `PARTNER_OFFER_NOT_FOUND`, `GROUP_OFFER_NOT_FOUND`, `GROUP_OFFER_PHASE`, `GROUP_OFFER_FULL`, `GROUP_OFFER_JOINED`, `GROUP_OFFER_NOT_JOINED`, `PRAYER_PLACE_NOT_SET`, `BUS_ROUTE_NOT_FOUND`, `GALLERY_ALBUM_NOT_FOUND`, `GALLERY_PHOTO_NOT_FOUND`, `GALLERY_REPORT_EXISTS`, `VISITOR_DETAILS_PURGED`, `COMMON_AREA_NOT_FOUND`.
