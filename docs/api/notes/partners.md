# Partners: backend notes for the mobile team

What was built for the compound's service partners, from the resident's side:
- finding a partner by category, sub-category, open now, open late, new, or favourite;
- asking one for a service in a window, with optional price lines and a gate pass;
- answering a partner's proposed time, marking done or not come, cancelling;
- rating a request, and complaining about one;
- a partner suspended, and the alternatives offered.

The partner answers on a web desk opened from a link (`/p#<token>`, in `apps/public`), or the management answers for it. Neither needs the app. The design decisions are in [ADR 0060](../../decisions/0060-partners.md). The contract is `docs/api/openapi.v0.json` (regenerated), with the Postman collection.

Conventions, as everywhere in API v0:

- Every path is under `/api/v1`, with `Authorization: Bearer <access token>`.
- Lists are `{ "data": [...], "nextCursor": string | null }`; pass `nextCursor` back as `?cursor=`.
- Errors are `{ "statusCode", "code", "message", "params"?, "fields"?: [{ "field", "code", "params"? }], "requestId", ... }`. Switch on `code` and `fields[].code`, never on `message`.
- Creates take an optional `Idempotency-Key` header (a UUID): a retry with the same key answers the same, once.
- **Every response here is `Cache-Control: no-store`.**
- Instants are ISO 8601 UTC. Hours (`startMinute`, `endMinute`, minutes from midnight) are in the **compound's** time zone (`timeZone` on each partner).
- Prices are EGP strings with two decimals (`"150.00"`). They are announced, never charged: nothing is paid in the app.

## Contents

1. [Categories and consent](#categories-and-consent)
2. [Finding partners](#finding-partners)
3. [Favourites](#favourites)
4. [Asking a partner](#asking-a-partner)
5. [The request's life](#the-requests-life)
6. [The request view](#the-request-view)
7. [The gate pass](#the-gate-pass)
8. [Rating](#rating)
9. [Complaining](#complaining)
10. [A suspended partner](#a-suspended-partner)
11. [Push notifications](#push-notifications)
12. [Value lists](#value-lists)
13. [Errors](#errors)
14. [Where we differ from the request](#where-we-differ-from-the-request)
15. [Not built](#not-built)

---

## Categories and consent

### `GET /partner-categories` → `200`

**Who:** residents and family (`partners.request`). The 13 categories, each with the compound's active sub-categories and the consent a request in it needs.

```json
{
  "data": [
    {
      "category": "home_services",
      "consentCode": "partner_share_home_services",
      "subcategories": [
        { "id": "…", "key": "cleaning", "nameEn": "Cleaning", "nameAr": "تنظيف" }
      ]
    }
  ],
  "nextCursor": null
}
```

**Consent.** A request shows the partner the unit's code, the resident's first name, the window, the note and the price lines. Before the first request in a category, show what is shared and grant `consentCode` with the existing `POST /me/consents/grant`. Without it, the create answers `409 CONSENT_REQUIRED` with `params.code`.

A resident who revokes it (`POST /me/consents/revoke`) hides all of that from the partner on every request in the category at once. The partner can no longer act on them; the resident still can.

## Finding partners

### `GET /partners` → `200`

Query, all optional: `category`, `subcategoryId`, `openNow=true`, `openLate=true`, `new=true`, `favourites=true`, `cursor`, `limit`. Only active partners are listed.

```json
{
  "id": "…",
  "nameEn": "Clean Co", "nameAr": "كلين كو",
  "descriptionEn": null, "descriptionAr": null,
  "businessPhone": "+201001234567",
  "serviceBuildings": [],
  "homeVisit": true,
  "services": [{ "category": "home_services", "subcategory": { "id": "…", "key": "cleaning", "nameEn": "Cleaning", "nameAr": "تنظيف" } }],
  "hours": [{ "weekday": 6, "startMinute": 540, "endMinute": 1380 }],
  "priceItems": [{ "id": "…", "subcategoryId": "…", "nameEn": "Visit", "nameAr": "زيارة", "price": "150.00", "unit": "visit_fee" }],
  "listedAt": "2026-11-01T08:00:00.000Z",
  "openNow": true,
  "openLateTonight": true,
  "isNew": true,
  "favourite": false,
  "timeZone": "Africa/Cairo",
  "rating": { "average": "4.33", "count": 3 },
  "status": "active"
}
```

- `serviceBuildings` empty means the whole compound. Asking from a unit elsewhere is refused (`PARTNER_OUT_OF_AREA`): grey the button out.
- `weekday`: 0 = Sunday … 6 = Saturday. `endMinute` may be 1440. A window ending at 1440 and one starting at 0 the next day are one stretch across midnight.
- **A paid home service** is a price item with `unit: "visit_fee"`. Show it as such.
- `openLateTonight`: open at some point today after 22:00 (the compound's setting) or now, whichever is later.
- `isNew`: listed in the last 30 days (the compound's setting).
- `rating` is `null` until three requests were rated.
- `businessPhone` is the only contact. Calling is outside the app.

### `GET /partners/{id}` → `200`

The same, with `alternatives` (empty for an active partner). See [A suspended partner](#a-suspended-partner).

## Favourites

- `PUT /partners/{id}/favourite` → `204`. Once; at most 50 (`409 PARTNER_FAVOURITES_LIMIT_REACHED`, `params.max`).
- `DELETE /partners/{id}/favourite` → `204`, also for a suspended partner.

## Asking a partner

### `POST /partner-requests` → `201` (Idempotency-Key)

**Who:** residents and family, for a unit they live in, **who may invite visitors there**. A household member whose primary has not granted visitors gets `403 PARTNER_REQUEST_NOT_ALLOWED`. Hide the button for them: the unit's capabilities (`visitorsInvite`) say it.

```json
{
  "partnerId": "…",
  "unitId": "…",
  "category": "home_services",
  "subcategoryId": "…",
  "windowStartsAt": "2026-11-14T09:00:00.000Z",
  "windowEndsAt": "2026-11-14T11:00:00.000Z",
  "note": "Two bedrooms",
  "items": [{ "priceItemId": "…", "quantity": 1 }],
  "gatePass": true
}
```

- `category` must be one the partner offers, and `subcategoryId` (optional) one it offers in that category (`PARTNER_SERVICE_NOT_OFFERED`).
- **The window** starts 15 minutes to 14 days from now and lasts 30 minutes to 8 hours (`PARTNER_WINDOW_TOO_SOON`, `PARTNER_WINDOW_TOO_FAR`, `PARTNER_WINDOW_LENGTH` on the fields).
- `note`: 1–500 characters, or leave it out.
- `items`: up to 10 of the partner's price items, quantity 1–99. Their names and prices are copied into the request: a later price change does not touch it.
- `gatePass`: whether the partner needs a pass at the gate (see [The gate pass](#the-gate-pass)).
- At most five requests open at once per account (the compound's setting, `PARTNER_REQUEST_LIMIT_REACHED`, `params.max`).

The partner is emailed that a request came, with no detail. A partner without a desk is handled by the management.

### `GET /partner-requests?state=live|closed` → `200`

The caller's own requests, newest first. `live` is pending, proposed and accepted.

They are also in the resident's lists (ADR 0058): `GET /me/requests` with `type: partner_request` and `kind` the category (`state=open` is the live ones), and `GET /me/search` by `SR-000123` or the partner's name.

### `GET /partner-requests/{id}` → `200`

One, with `history`.

## The request's life

| Status | Means | The resident may |
|---|---|---|
| `pending` | waiting for the partner | cancel |
| `proposed` | the partner offered another window (`proposedStartsAt`, `proposedEndsAt`) | accept it, decline it, cancel |
| `accepted` | agreed (`agreedStartsAt`, `agreedEndsAt`) | cancel; mark done once it started; say the partner did not come once it ended |
| `declined` | the partner said no (`closeReason`) | — |
| `cancelled` | by the resident, the partner or the system (`closedBy`, `closeReason`) | complain, when the partner cancelled |
| `expired` | nobody answered before the window started | — |
| `done` | done | rate (14 days), complain (14 days) |
| `partner_no_show` | the partner did not come | complain |
| `lapsed` | accepted, never closed, a week after the window | complain |

- `POST /partner-requests/{id}/cancel` `{ "reasonCode": "no_longer_needed" }` (`partnerRequestResidentCancel`).
- `POST …/accept-proposal`, `POST …/decline-proposal`: before the proposed window starts. Declining closes the request as `cancelled` with `proposal_declined`.
- `POST …/done`: once the agreed window started (`PARTNER_REQUEST_TOO_EARLY` before).
- `POST …/no-show`: once the agreed window ended.

Each answers the request as it is now. Repeating an action that already happened answers the same; anything else from the wrong status is `409 PARTNER_REQUEST_INVALID_TRANSITION` with `params.status`: refresh and show what is true.

## The request view

```json
{
  "id": "…", "number": "SR-000123",
  "category": "home_services",
  "subcategory": { "id": "…", "key": "cleaning", "nameEn": "Cleaning", "nameAr": "تنظيف" },
  "status": "accepted",
  "askedStartsAt": "…", "askedEndsAt": "…",
  "proposedStartsAt": null, "proposedEndsAt": null,
  "agreedStartsAt": "…", "agreedEndsAt": "…",
  "staffCount": 2,
  "gatePass": true,
  "closedBy": null, "closeReason": null,
  "acceptedAt": "…", "closedAt": null, "createdAt": "…",
  "partner": { "id": "…", "nameEn": "Clean Co", "nameAr": "كلين كو", "businessPhone": "+201001234567" },
  "unitId": "…", "unitCode": "B2-101",
  "note": "Two bedrooms",
  "items": [{ "nameEn": "Visit", "nameAr": "زيارة", "price": "150.00", "unit": "visit_fee", "quantity": 1 }],
  "lastActivityAt": "…",
  "passId": "…",
  "rating": null,
  "complaint": null,
  "history": [{ "kind": "accepted", "by": "partner_desk", "reasonCode": null, "startsAt": null, "endsAt": null, "at": "…" }]
}
```

- `closedBy`: `resident`, `partner_desk`, `relay` (the management for the partner) or `system`. Show `partner_desk` and `relay` both as "the partner".
- `staffCount`: how many people the partner sends (1–5), set when it accepts.
- `history[].kind`: `created`, `accepted`, `declined`, `proposed`, `proposal_accepted`, `proposal_declined`, `cancelled`, `done`, `no_show`, `expired`, `lapsed`, `pass_issued`, `pass_skipped`, `pass_cancelled`.

## The gate pass

When the partner accepts a request with `gatePass: true`, the gate issues a pass **as if the resident had invited the partner**:
- valid from 30 minutes before the agreed window (or now) to an hour after it;
- for `staffCount` people;
- named with the partner's Arabic name;
- one-time, as any visitor pass.

`passId` is set: open it with the existing visitor pass routes, and it shows in the resident's passes. The guard checks it as any pass.

- **No pass** when, at acceptance, the resident may no longer invite visitors or the unit has as many live passes as it may. The request is still accepted, `passId` stays `null`, and `history` has `pass_skipped` with `reasonCode` `host_cannot_invite` or `pass_limit`. Tell the resident to make a pass themselves; otherwise the guard calls them at the gate.
- **Cancelled** with the request (by anyone), or when the partner is suspended.
- The partner's desk shows the pass's code and link from two hours before the window until it ends.

## Rating

### `POST /partner-requests/{id}/rating` → `201`

`{ "stars": 4, "comment": "On time" }`: once (`PARTNER_REQUEST_ALREADY_RATED`), for a `done` request (`PARTNER_REQUEST_NOT_CLOSED`), within 14 days of done (`PARTNER_REQUEST_WINDOW_CLOSED`, `params.days`). `comment` is optional, up to 500 characters. The partner never sees a rating; the management reads the comments. The request's `rating` shows it after.

## Complaining

### `POST /partner-requests/{id}/complaint` → `201` (Idempotency-Key)

```json
{ "reason": "poor_quality", "compensationAsk": "refund", "requestedAmount": "150.00", "message": "The kitchen was not cleaned." }
```

- For a request `done`, `partner_no_show`, `lapsed` or cancelled by the partner, within 14 days of its window's end. Once per request (`PARTNER_COMPLAINT_EXISTS`).
- `requestedAmount` only with `refund` or `damages` (`PARTNER_AMOUNT_NOT_ASKED`).
- **It opens a management request** on the topic `partner_service`, with `message` as its first message. The answer contains `managementRequestId` and `managementRequestNumber`. Open the conversation, follow-ups and satisfaction in the existing management requests screens. That topic is not in the topics list: it opens only this way.
- The management decides once: `outcome` (`upheld`, `not_upheld`) and `compensation` (`none`, `redo`, `partner_refund`, `credit_note`). The resident is told. A credit note comes in the unit's invoices from finance; nothing is paid here.

The request's `complaint` shows it, with the decision once made.

## A suspended partner

- It disappears from `GET /partners`. A new request to it is `409 PARTNER_SUSPENDED`.
- Its live requests are cancelled by the system (`closeReason: partner_suspended`), with their passes.
- Residents with a live request to it and those keeping it as a favourite get one `partner.suspended` push, whose target is the partner.
- `GET /partners/{id}` still answers, with `status: "suspended"` and up to three `alternatives` (partners in the same categories, open now first, then the best rated). Show them. The reason is never given.

## Push notifications

Category `partners` (in the notification preferences). None is critical. Targets are `partner_request`, `partner_complaint` or `partner`. Params are codes only.

| Kind | When | Params |
|---|---|---|
| `partner_request.accepted` | the partner accepted | — |
| `partner_request.declined` | the partner declined | `reason` |
| `partner_request.proposed` | the partner proposed another window | — |
| `partner_request.cancelled` | the partner cancelled an accepted request | `side`, `reason` |
| `partner_request.done` | the partner marked it done: offer to rate | — |
| `partner_request.expired` | nobody answered in time | — |
| `partner_complaint.decided` | the management decided a complaint | `outcome`, `compensation` |
| `partner.suspended` | a partner asked or kept was suspended | — |

The resident's own actions push nothing. `partner_request.awaiting_relay` goes to the management only.

## Value lists

| List | Values |
|---|---|
| `PartnerCategory` | `gas_water`, `pharmacy`, `grocery`, `home_services`, `laundry`, `gardening`, `beauty_at_home`, `repair`, `pets`, `events`, `moving_storage`, `car_services`, `elderly_care` |
| `PartnerPriceUnit` | `fixed`, `per_visit`, `visit_fee`, `per_hour`, `per_item`, `per_kg`, `per_sqm` |
| `PartnerRequestStatus` | `pending`, `proposed`, `accepted`, `declined`, `cancelled`, `expired`, `done`, `partner_no_show`, `lapsed` |
| `partnerRequestResidentCancel` | `no_longer_needed`, `found_another`, `wrong_details`, `other` |
| `partnerRequestDecline` (a partner's) | `unavailable`, `out_of_area`, `not_offered`, `other` |
| `partnerRequestPartnerCancel` | `unavailable`, `emergency`, `other` |
| `partnerRequestSystemCancel` | `partner_suspended`, `requester_left` |
| `partnerComplaint` | `no_show`, `late`, `poor_quality`, `overcharged`, `damage`, `conduct`, `other` |
| `partnerCompensationAsk` | `none`, `refund`, `redo`, `damages` |
| `partnerCompensationDecision` | `none`, `redo`, `partner_refund`, `credit_note` |
| consent codes | `partner_share_<category>`, one per category, version 1 |

A code outside its list is a field error with `params.allowed`: `INVALID_REASON_CODE` for a `reasonCode` or a complaint's `reason`, `INVALID_VALUE` for `compensationAsk` and `compensation`.

## Errors

| Code | Status | When |
|---|---|---|
| `PARTNER_NOT_FOUND` | 404 | unknown partner |
| `PARTNER_SUSPENDED` | 409 | asking a suspended partner |
| `PARTNER_OUT_OF_AREA` | 409 | the unit's building is outside its area |
| `PARTNER_FAVOURITES_LIMIT_REACHED` | 409 | 50 favourites already (`params.max`) |
| `CONSENT_REQUIRED` | 409 | the category's consent is not granted (`params.code`) |
| `PARTNER_REQUEST_NOT_ALLOWED` | 403 | the caller may not invite visitors to the unit |
| `PARTNER_REQUEST_LIMIT_REACHED` | 409 | too many open requests (`params.max`) |
| `PARTNER_REQUEST_NOT_FOUND` | 404 | unknown, or not the caller's |
| `PARTNER_REQUEST_INVALID_TRANSITION` | 409 | the status does not take it (`params.status`) |
| `PARTNER_REQUEST_WINDOW_PASSED` | 409 | the window has started (accept a proposal) |
| `PARTNER_REQUEST_TOO_EARLY` | 409 | done before the start, no-show before the end |
| `PARTNER_REQUEST_ALREADY_RATED` | 409 | rated already |
| `PARTNER_REQUEST_NOT_CLOSED` | 409 | not a request this applies to (`params.status`) |
| `PARTNER_REQUEST_WINDOW_CLOSED` | 409 | past the days allowed (`params.days`) |
| `PARTNER_COMPLAINT_EXISTS` | 409 | complained already |

Field codes (in `fields[]`): `PARTNER_SUBCATEGORY_NOT_AVAILABLE`, `PARTNER_SERVICE_NOT_OFFERED`, `PARTNER_WINDOW_TOO_SOON`, `PARTNER_WINDOW_TOO_FAR`, `PARTNER_WINDOW_LENGTH`, `PARTNER_PRICE_ITEM_NOT_AVAILABLE`, `PARTNER_AMOUNT_NOT_ASKED`.

## Where we differ from the request

- **Prices are EGP decimals**, not integer piastres, as everywhere money is stored.
- **A household member needs the visitors grant** to ask a partner: a partner comes in as a visitor, so asking one is inviting one.
- **The partner is told by email, with no detail**, and answers on a web desk. There is no partner app and no integration.
- **The resident's own actions push nothing to the partner.** The desk shows them when the partner opens it.

## Not built

- Paying a partner in the app, or any money moving.
- Chat with a partner: the business phone is the contact.
- Push for new partners: `new=true` shows them.
- Tracking a partner's staff inside the compound beyond the gate pass.
