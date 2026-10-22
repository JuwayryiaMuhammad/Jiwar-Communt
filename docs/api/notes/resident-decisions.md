# The resident's side: backend notes for the mobile team

What R11b-1 built for residents and their families:
- the login history and the devices, each signed out on its own;
- the inbox, sorted by category, archived and deleted;
- a ticket's timeline, and a quote to approve before the work starts;
- one list of everything asked for, one of appeals, and one search;
- who answers each kind of request, and when the office is open;
- a request to release something held;
- formal notices, with delivery and read proof;
- a credit note, a compensation and a failed payment, each told to the unit;
- the services a unit is suspended from.

The design decisions are in [ADR 0058](../../decisions/0058-resident-communication-decisions.md). The contract is `docs/api/openapi.v0.json` (regenerated), with the Postman collection.

Conventions, as everywhere in API v0:

- Every path is under `/api/v1`, with `Authorization: Bearer <access token>`.
- Lists are `{ "data": [...], "nextCursor": string | null }`.
- Errors carry `code` and `fields[].code`; switch on those, never on `message`.
- Send an `Idempotency-Key` with every create and every decision.

## Contents

1. [Logins and devices](#logins-and-devices)
2. [The inbox](#the-inbox)
3. [A ticket's timeline and its quote](#a-tickets-timeline-and-its-quote)
4. [My requests, my appeals, search](#my-requests-my-appeals-search)
5. [Talking to the management](#talking-to-the-management)
6. [Formal notices](#formal-notices)
7. [Money told](#money-told)
8. [Suspended services](#suspended-services)
9. [Push notifications](#push-notifications)
10. [Value lists](#value-lists)
11. [Errors](#errors)
12. [Not built](#not-built)

---

## Logins and devices

**`GET /me/logins`** returns the last 90 days of logins, newest first, paged:

```json
{
  "data": [
    {
      "id": "…",
      "at": "2026-10-22T09:12:00.000Z",
      "device": { "id": "…", "deviceType": "android", "os": "android", "client": "app" },
      "isCurrent": true
    }
  ],
  "nextCursor": null
}
```

- **The label:** `os` is one of `ios`, `android`, `windows`, `macos`, `linux`, `other`. `client` is `app`, or a browser family: `edge`, `opera`, `samsung`, `firefox`, `chrome`, `safari`, `other`. Name them in the reader's language.
- **What is never shown:** there is no place, no IP and no user agent. Do not add a "location" line.
- **Send `X-Jiwar-Install-Id`** on every login (ADR 0036). Without it, every login looks like a browser.

**`GET /me/devices`** lists the devices with `firstSeenAt`, `lastSeenAt`, `liveSessions` and `isCurrent`.

**`POST /me/devices/{id}/revoke`** answers `{ "revoked": n }`:
- it ends the device's sessions; the current one is ended too, if it is on that device;
- the device's next login raises the new-device alert again;
- another account's device, or a disowned one, is `404 DEVICE_NOT_FOUND`.

**`GET /me/sessions`** gains `device` (the same label, or `null` for sessions started before this phase).

## The inbox

`GET /me/notifications` takes two more filters:
- **`?category=`**: one of the preference categories (`maintenance`, `finance`, …);
- **`?archived=true`**: the archive alone. Archived notifications are left out by default.

Each item gains `archivedAt`.

| Action | Route | Answer |
|---|---|---|
| Archive (also marks it read) | `POST /me/notifications/{id}/archive` | `204`, idempotent |
| Back to the list (stays read) | `POST /me/notifications/{id}/unarchive` | `204` |
| Delete | `DELETE /me/notifications/{id}` | `204`; again: `404 NOTIFICATION_NOT_FOUND` |

**Formal notices are not notifications.** Deleting the notification of a formal notice leaves the notice itself in `GET /me/notices`.

## A ticket's timeline and its quote

**`GET /tickets/{id}/timeline`**: every status change, oldest first.

```json
{ "data": [
  { "from": null, "to": "new", "at": "…", "reasonCode": null, "cycle": 1, "by": "you" },
  { "from": "new", "to": "assigned", "at": "…", "reasonCode": null, "cycle": 1, "by": "management" },
  { "from": "in_progress", "to": "on_hold", "at": "…", "reasonCode": "awaiting_parts", "cycle": 1, "by": "technician" }
] }
```

`by` is `you`, `household`, `management`, `technician` or `system`. There is never a name.

**Quotes.** The management may state what the work will cost before it starts.
- **Reading:** `GET /tickets/{id}/quotes`, oldest first. Each quote has `amount` (EGP), `note`, `status` (`proposed`, `approved`, `declined`, `withdrawn`), `decidedByMe`, `declineReason` and `mayDecide`.
- **Who decides:** the reporter or the unit's primary, while `mayDecide` is true.
  - `POST /tickets/{id}/quotes/{quoteId}/approve` (`204`);
  - `POST …/decline` with `{ "reasonCode": "too_expensive" }` (`ticketQuoteDecline`).
  - A second decision is `409 TICKET_QUOTE_INVALID_TRANSITION` with `params.status`.
- **While a quote waits, or after a decline,** the technician cannot start (`TICKET_QUOTE_NOT_APPROVED`). Show "waiting for your approval" on the ticket. A declined quote leaves the ticket for the management to quote again or cancel.

**Visits:** `GET /me/units/{unitId}/visits` gains `confirmedAt` and `arrivedAt`.

## My requests, my appeals, search

### `GET /me/requests` and `GET /me/appeals`

For residents and family only; staff get `403`. `?state=open|closed` (closed is the archive), paged.

```json
{
  "type": "unit_permit",
  "id": "…",
  "number": "W-0012",
  "status": "approved",
  "lastActivityAt": "…",
  "unitId": "…",
  "kind": "works",
  "categoryKey": null,
  "topicKey": null,
  "requestType": null,
  "appeal": null
}
```

- **`type`, the screen to open:**

  | `type` | Opens |
  |---|---|
  | `maintenance` | `/tickets/{id}` |
  | `management` | `/management-requests/{id}` |
  | `invoice_dispute` | `/invoice-disputes/{id}` (`number` is the invoice's) |
  | `unit_permit` | `/permits/{id}` |
  | `neighbour_complaint` | `/neighbour-complaints/{id}` |
  | `vehicle_fine` | `/vehicle-fines/{id}` |
  | `unit_violation` | `/violations/{id}` |
  | `board_appeal` | `/governance/board-appeals/{id}` |
  | `invoice` | `/invoices/{id}` |
  | `booking` | `/bookings/{id}` |
  | `parcel` | `/me/parcels/{id}` |
  | `formal_notice` | `/me/notices/{id}` |

- **`status`** is the item's own code: show it with the item's own labels.
- **Appeals carry `appeal`:** `{ state: pending | upheld | overturned | withdrawn, at, decidedBy: management | board, decidedAt }`. `upheld` means the decision stands; `overturned` means the appellant won. Who decided is the management or the board, never a person.
- **A certificate or a letter** is a management request on the `documents` topic.
- **This changed:** a resident whose role has neither `requests.create` nor `tickets.create` now gets an empty list, not `403`.

### `GET /me/search?q=` → `200`

- **The text:** 2–64 characters, with no `%`, `_` or `\`.
- **What matches:** a reference (`MT-000123`, `mt123` or `123` all find ticket 123), or words of a name the compound wrote: a ticket category, a request topic, a facility.
- **What is returned:** the caller's own items, the same shape as above, newest first. At most 10 of a kind and 50 in all.
- **Not searchable:** visitor passes (they have no reference).
- **The limit:** 30 searches a minute per account, then `429 RATE_LIMITED`. Search as the user submits, not on every keystroke.
- **History:** keep the search history on the device. The server keeps none.

## Talking to the management

**Who answers.** `GET /management-request-topics` gains `owner`:
- `{ "roleKey": "billing", "roleName": "Accounts office" }`, or `null` when any handler answers;
- `roleName` is the compound's own; when it is `null`, name the role by `roleKey`.

**`GET /management-office-hours`** → `200`:

```json
{
  "windows": [ { "weekday": 6, "startMinute": 540, "endMinute": 1020 } ],
  "timeZone": "Africa/Cairo",
  "openNow": false,
  "closesAt": null,
  "nextOpensAt": "2026-10-24T06:00:00.000Z"
}
```

- `weekday` 0 is Sunday; minutes are local.
- The expected reply time is still each topic's `targetResponseHours`.

**Asking to release a hold.** Open a request on the `release_request` topic with `about`:

```json
{ "type": "general", "topicId": "<release_request topic>", "body": "The parts arrived yesterday.",
  "about": { "type": "maintenance", "id": "<ticket id>" } }
```

- **What `about` names:**
  - `maintenance`: a ticket on hold;
  - `unit_permit`: a works permit stopped at the gate;
  - `unit_credit`: the unit's credit awaiting a refund (`id` is the unit's id).
- **The hold's reason** is kept on the request: `about.reasonCode` on every request view.
- **Refusals:**
  - something not held, or not the caller's to see: `404 HELD_ITEM_NOT_FOUND`;
  - a second live request for the same hold: `409 DUPLICATE_RESOURCE` on `about`;
  - `about` with another topic: `400 RELEASE_TOPIC_REQUIRED` on `topicId`;
  - the release topic without `about`: `FIELD_REQUIRED`.

## Formal notices

A formal notice is the management's formal letter about a unit. Today there is one type, `late_payment`: an invoice still owed after its due date and the compound's cure period (14 days by default).

**`GET /me/notices`** lists them newest first.

**`GET /me/notices/{id}`** opens one. **The first opening is recorded as read**; open it when the person opens the screen, not in the background.

```json
{
  "id": "…",
  "number": "FN-000003",
  "type": "late_payment",
  "unitId": "…",
  "subjectType": "invoice",
  "subjectId": "<invoice id>",
  "amount": "1000.00",
  "dueOn": "2026-10-01",
  "issuedAt": "…",
  "deliveredAt": "…",
  "emailedAt": "…",
  "readAt": "…"
}
```

- **Delivery:** the notice is also emailed, whatever the email preferences.
- **What to show:** what is owed, and the actions "Pay" (`/invoices/{subjectId}`) and "Contact the management".

## Money told

| Notification | When | Params |
|---|---|---|
| `credit_note.issued` | the management credited one of the unit's invoices | `reason` (a `creditNote` code) |
| `compensation.granted` | a compensation, as a credit on an invoice | `reason` (`service_outage`, `maintenance_delay`, `facility_closure`, `other`) |
| `payment.failed` | a checkout's first failed attempt, to its payer | — |
| `formal_notice.issued` | a formal notice | `type` |

- **Targets:** the first two open the invoice. Credit notes on the invoice gain `compensationReason`.
- **After a failure,** `GET /payment-sessions/{id}` lists `alternatives`. Offer them as buttons:
  - `retry`: the hosted page, while it is open, for the payer;
  - `new_checkout`: once it is over;
  - `pay_at_office`;
  - `ask_management`: a request on the billing topic.

## Suspended services

**`GET /me/units/{unitId}/service-standing`** returns `200` for whoever has a place on the unit, and `404 UNIT_NOT_FOUND` otherwise.

```json
{ "data": [
  { "service": "bookings", "reason": "no_shows", "since": "…", "until": "…",
    "restore": ["wait_until", "appeal_board"], "appealUntil": "…" }
] }
```

- An empty list means nothing is suspended.
- **`restore`, what to offer:**
  - `wait_until`: it ends by itself at `until`;
  - `appeal_board`: an appeal to the board (owners and primaries) until `appealUntil`.

## Push notifications

The new kinds, in categories `maintenance` and `finance`, none critical:
- `ticket.quote_proposed` (params `ticketNumber`, `amount`), `ticket.quote_withdrawn`;
- `credit_note.issued`, `compensation.granted`, `payment.failed`, `formal_notice.issued`.

The staff's: `ticket.quote_approved`, `ticket.quote_declined` (`reason`).

## Value lists

| List | Values |
|---|---|
| `ticketQuoteDecline` | `too_expensive`, `not_needed`, `own_arrangement`, `other` |
| `creditNote` (staff) | adds `compensation` |
| `creditNoteCompensation` | `service_outage`, `maintenance_delay`, `facility_closure`, `other` |

## Errors

| Code | When |
|---|---|
| `DEVICE_NOT_FOUND` (404) | not the caller's device, or disowned |
| `TICKET_QUOTE_NOT_FOUND` (404) | not a quote of that ticket |
| `TICKET_QUOTE_INVALID_TRANSITION` (409) | decided or withdrawn already (`params.status`) |
| `TICKET_QUOTE_NOT_APPROVED` (409) | the work waits for the quote (`params.status`) |
| `HELD_ITEM_NOT_FOUND` (404) | nothing held of the caller's by that id |
| `FORMAL_NOTICE_NOT_FOUND` (404) | not the caller's notice |
| `RATE_LIMITED` (429) | more than 30 searches a minute |

## Not built

- A place in the login history.
- Debtor service suspension.
- An invoice made from a quote.
- Searching visitor passes.
- Appeals of other decisions (permits, vehicles, workers, neighbour notices), complaints against the management, and the building representative: R11b-2.
