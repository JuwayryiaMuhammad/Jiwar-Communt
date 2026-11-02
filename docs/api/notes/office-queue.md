# Announcements and the office queue (ADR 0080)

## Announcements

- **To single units.** `audience: { occupancy, unitIds: [...] }` on `POST/PATCH /community/announcements` and `POST /community/audience/preview`: up to 200 of the compound's units, never beside `buildings` (`FIELD_NOT_ALLOWED` on `audience.unitIds`; an unknown unit `INVALID_VALUE` on `audience.unitIds.<i>`). The staff's views carry `audience.unitIds`, `audienceUnitCodes` and `remindedAt`.
- **Delivery.** `GET /community/announcements/{id}/delivery`: `notified`, `reminded`, `notifiedRead`, `remindedRead`, `pushSent`, `pushFailed`, `pushPending`, `opened` (the read counts). Counts only.
- **One reminder.** `POST /community/announcements/{id}/remind` → `{ recipients }`: once ever (`409 ANNOUNCEMENT_ALREADY_REMINDED {remindedAt}`), while it is out (`409 ANNOUNCEMENT_INVALID_STATE {status}`). Notification `community_announcement.reminder`, no params.
- **Templates.** `GET/POST /community/announcement-templates`, `PATCH/DELETE …/{id}` (`community.publish`): `name` (once a compound, `DUPLICATE_RESOURCE`), `titleEn/bodyEn/titleAr/bodyAr`.

## The office queue

- **Outreach.** `POST /management/outreach { residentAccountId, topicId, unitId?, body, attachmentFileIds? }` (`requests.handle` + `residents.read`, idempotent): starts `answered`, `outreach: true`; the resident is told (`management_request.outreach`).
- **Another topic.** `POST /management/requests/{id}/topic { topicId }` → 204 (`SAME_AS_CURRENT`, `TOPIC_NOT_AVAILABLE`, `409 MANAGEMENT_REQUEST_TOPIC_FIXED`).
- **Into a ticket.** `POST /management/requests/{id}/convert { target: ticket | work_order, categoryId, priority?, description, commonAreaId? | assetId? }` (also `tickets.dispatch`) → 201 `{ id, number }`. The request closes `converted` with `convertedTicket`; reopening it is `409 MANAGEMENT_REQUEST_CONVERTED {ticketNumber}`. Notification `management_request.converted {requestNumber, topicKey, ticketNumber}`.
- **By unit.** `GET /management/requests?unitId=`.
- **Reply templates.** `GET /management/reply-templates?topicId=` (`requests.handle`); `POST`, `PATCH/DELETE …/{id}` (`requests.manage`): `name`, `topicId` (null: any), `bodyEn/bodyAr`.
- Request views gain `outreach` and `convertedTicket`; `closeReason` may be `converted`.

## Suggestions

- `deferred` in `SuggestionStatus`; `POST /community/suggestions/{id}/status` needs `response` for `done`, `deferred` and `declined`.

## Official letters

- `GET/POST /staff/official-letters`, `GET …/{id}`, `POST …/{id}/revoke { reasonCode }` (`officialLetterRevoke`), `GET …/{id}/pdf` (`letters.issue`).
- `POST` body: `kind` (`residence_confirmation | no_objection | to_whom_it_may_concern`), `unitId`, `accountId`, `requestId?`, `addressee?`, `subject?` (required for `no_objection`). `409 OFFICIAL_LETTER_NOT_OCCUPANT`, `409 OFFICIAL_LETTER_REVOKED`, `409 OFFICIAL_LETTER_ERASED` (the PDF of an erased subject).
- `GET /me/official-letters`, `GET /me/official-letters/{id}/pdf` (`units.read`): the caller's own.
- `POST /public/letters/lookup { code }` (public, rate-limited per IP): `{ status: valid | revoked, issuer, issuedOn }`; any miss is `404 OFFICIAL_LETTER_NOT_FOUND`.
- Notification `official_letter.issued {letterNumber, letterKind}` to the subject.

## A unit's correspondence

- `GET /staff/units/{unitId}/correspondence?type=&cursor=&limit=` (`correspondence.read`): `{ type, id, number, kind, status, direction: from_unit | to_unit, at }`, newest first. Each read is audited (`unit.correspondence_read`).
