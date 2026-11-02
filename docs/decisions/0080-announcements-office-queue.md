# 0080 — Announcements and the office queue: announcements to single units, their delivery and one reminder, announcement and reply templates, a conversation the management starts, a request put under another topic or turned into a ticket, a unit's correspondence, deferred suggestions, and official letters with a public check

**Status:** Accepted · M2-9 · amends ADR 0039 (a request the management starts; a new topic; `converted`), 0040 (a unit audience; `deferred`; done answered), 0058 (a registry of a unit's correspondence beside `ResidentItems`), 0062 (official letters on the certificates' renderer and public check)

## Context

The manager audit of 2026-11-01 (the residents' slice, groups M-R2 and M-R3; plan row M2-9) found that the management could put an announcement to buildings but not to a unit; it saw who opened one as two counts but nothing of how it was delivered, and had no way to remind those who had not opened it; it had no saved words, for announcements or for answers in the queue; it could record that a resident called but could not write to one first; a request stayed under the topic the resident picked, and turning one into a ticket was done by hand, unlinked; a unit's exchanges were spread over five lists; a suggestion could not be put off with a reason; and the "official letters" the office issues on request had no record, number or check. The owner approved the plan and every recommendation of the audits (2026-11-01): "category" in targeting is occupancy, delivery tracked for notified announcements with one reminder, a deferred status with an answer on done, deferred and declined, official letters from a closed list signed by the issuing manager's record and a verify code, no e-signature vendor. The daily brief's settings are M2-4's.

## Decisions

### Announcements to single units

- `announcements.audience_units` (up to 200 of the compound's units; a CHECK: never beside buildings): an announcement's audience is buildings **or** units, within the occupancy chosen (`everyone`, `owners`, `tenants`). `AnnouncementAudienceDto.unitIds`; both is `FIELD_NOT_ALLOWED` on `audience.unitIds`, an unknown unit `INVALID_VALUE` on `audience.unitIds.<i>`. Events and polls keep buildings alone.
- `inAudience` (community) is still the one rule: a unit audience is those units' places. The lists use one branch per place with its unit's condition beside its capacity and building (`announcementAudienceWhere`), so a place in a named unit never lends its unit to another place's capacity, and a list and a single read agree.
- Fixed once out, as the rest of the audience. The preview counts a unit audience. The staff's views show the unit ids and their codes.

### Delivery and the one reminder

- `GET /community/announcements/{id}/delivery` (`community.publish`): the inbox rows its notice and its reminder wrote and how many were read there, the pushes for them by outcome (`sent`, `dead` as failed, the rest pending) while their rows are kept (ADR 0041's retention), and who opened it (the read marks). Counts only; a normal announcement never reminded has no notice rows.
- `POST /community/announcements/{id}/remind`: once ever, while it is out, under the announcement's row lock (`409 ANNOUNCEMENT_ALREADY_REMINDED` with `remindedAt`; `409 ANNOUNCEMENT_INVALID_STATE` otherwise). Who has not opened it is derived at run time: each audience member's account mark is derived again with the secret and looked up (ADR 0040); nothing stores who was reminded but the inbox rows (`community_announcement.reminder`, no params). `reminded_at` (after publication, a CHECK). Audited with the counts (`announcement.reminded`). Two reminders at once: one goes, the other waits on the lock and is refused.

### Templates

- `announcement_templates` (`/community/announcement-templates`, `community.publish`): a name (once a compound; `DUPLICATE_RESOURCE` on `name`) and the words in English, Arabic or both (an announcement's lengths). The composer copies one into a draft.
- `request_reply_templates` (`/management/reply-templates`): for a topic or for any; read by `requests.handle` (`?topicId=` gives a topic's own and those for any), written by `requests.manage`; a message's 4000 characters.
- Nothing points back at a template: changed and deleted freely. Audited by name (and topic), the words as `{ changed: true }`.

### A conversation the management starts

- `POST /management/outreach` (`requests.handle` and `residents.read`): a request whose author is the resident — they read it as from the office and answer it — with `outreach` and `openedBy` and no on-behalf reason (the CHECK recreated). Its first message is staff's official one, so it starts **answered**: it waits for the resident, is no item of the staff's queue, and closes by itself after the compound's days if never answered (ADR 0039's sweep). The resident's answer puts it in hand. The resident is told (`management_request.outreach`). Audited `management_request.outreach_started`.

### Another topic

- `POST /management/requests/{id}/topic`: a live request under another active topic; its due time is the new topic's target from the cycle's start; the owner role routing follows (ADR 0058). A request about a hold or on a system topic keeps its own (`409 MANAGEMENT_REQUEST_TOPIC_FIXED`), none moves onto the release topic (`TOPIC_NOT_AVAILABLE`), the same topic is `SAME_AS_CURRENT`. The new topic's handlers are told when nobody holds it (`management_request.reclassified`). Audited by key.

### A request turned into a ticket

- `POST /management/requests/{id}/convert` (also `tickets.dispatch`): in **one transaction under the request's row lock**, maintenance opens, through a port (`MaintenanceManagementPort`) and its services' own in-transaction paths:
  - `ticket`: the resident's ticket in the request's unit on their behalf (ADR 0032; a request about no unit is `INVALID_VALUE` on `target`), they its reporter;
  - `work_order`: the management's work order on a common area or an asset (ADR 0076), for a fault reported outside the unit.
- The request closes `converted` (staff's side), `converted_ticket_id` pointing at the ticket (a composite key; one request a ticket), never reopened (`409 MANAGEMENT_REQUEST_CONVERTED` with the ticket's number; a CHECK holds it closed; a trigger keeps the link). Its closing handlers run (a live appointment ends). The resident is told the ticket's number (`management_request.converted`). Dispatched once committed.
- Two converts at once: the second waits on the lock, finds it closed (`409 MANAGEMENT_REQUEST_INVALID_TRANSITION`), and opens nothing.
- `GET /management/requests?unitId=` lists one unit's requests.

### A unit's correspondence

- A core registry, `UnitCorrespondence`, as `StaffInbox` and `ResidentItems`: each domain registers its source at startup (every type checked when the app starts) and reads it in the caller's tenant transaction. Six types: the requests about the unit (`to_unit` when the management started it) and the official letters (management), the announcements whose audience names the unit (engagement), the neighbour complaints its people filed and those about it — never who filed one (neighbours), its formal notices (core), its tickets by origin (maintenance).
- `GET /staff/units/{unitId}/correspondence` (`correspondence.read`, the manager's; each source also needs its own list's permission), newest first on one keyset, `?type=`. Codes and references only.
- It shows who wrote to whom about the unit, so **every read is logged** (`unit.correspondence_read`: the unit and the row count).

### Deferred suggestions (amends ADR 0040)

- `deferred`: not now, from any step before the end, and on to any later — never back to received. Done, deferred and declined are each answered (`FIELD_REQUIRED` on `response`); a CHECK holds a deferred one's answer.

### Official letters

- `official_letters` (`OL-` from the compound's counter; `letters.issue`, the manager's): kinds from a closed list — `residence_confirmation`, `no_objection` (says to what: `subject` required), `to_whom_it_may_concern` — for an owner or a tenant holding a live occupancy of the unit, read `FOR SHARE` until the commit (`409 OFFICIAL_LETTER_NOT_OCCUPANT`); optionally answering one of their requests; an addressee and a subject printed as staff wrote them.
- **A record.** The name as written, the capacity and since when are frozen at its issue; a trigger allows one revocation and one erasure of the name, nothing else, no delete. Its PDF is drawn on demand with certificate.v2 (ADR 0062), the same bytes each time: for the staff and for its subject (`GET /me/official-letters`, `…/{id}/pdf`, `units.read`).
- **The check.** A 22-character base64url code (16 random bytes: 128 bits, never guessed) on the row, its SHA-256 in the global `official_letter_links`, as clearances. `POST /public/letters/lookup {code}`: rate-limited per IP, a malformed code refused before any read, every miss one 404, and it answers **only** `status` (`valid | revoked`), `issuer` (the compound) and `issuedOn` (its day in the compound's zone) — no name, unit, number or words.
- Revoked once with a code (`officialLetterRevoke`; `409 OFFICIAL_LETTER_REVOKED`). The subject is told of a new letter (`official_letter.issued`: number and kind).
- **Privacy.** The name is the one personal value: the subject's erasure clears it, the letter and its check stay, its PDF is no longer drawn (`409 OFFICIAL_LETTER_ERASED`). The export gains `official-letters.json`.

### Nothing new for the staff inbox

- An outreach waits for the resident (answered) and enters the queue as any request when they answer; a converted request leaves it; a deferred suggestion is parked; a letter answers a request already there. No inbox type is added and the `staff_inbox` CHECKs are unchanged.

## Deviations for the owner

1. **A reminder is allowed for any announcement that is out**, normal ones too (whose first notice it then is), once; the audit spoke of delivery for notified ones. Its delivery shows both notices' counts.
2. **Push counts last as long as the delivery rows** (ADR 0041 purges them); the inbox counts are kept.
3. **An outreach starts answered** and closes by itself if never answered, as an answered request does.
4. **A request about a hold, or on a system topic, keeps its topic**; nothing moves onto the release topic.
5. **Converting goes to a ticket or a work order only**; a permit or a partner request are not targets yet (the audit named them; their domains have no in-transaction path for it).
6. **A converted request is never reopened**: the resident follows the ticket, which they may reopen in its own window.
7. **Letters print the name, the unit, the capacity and since when — no ID number.** Signed by the compound's record and the code, no e-signature.
8. **The public check gives no letter number**: only validity, the issuer and the day, as the brief asked.
9. **An erased subject's letter stays valid** at its check; only its PDF is no longer drawn.
10. **The outreach dialog** is not on the dashboard yet; the route is (`POST /management/outreach`).

## Consequences

- New tables `announcement_templates`, `request_reply_templates`, `official_letter_counters`, `official_letters` (forced RLS) and the global `official_letter_links`; new columns on `announcements`, `management_requests`; one enum value (`deferred`).
- Migrations 20270323090000 (the enum value), 090100 (an announcement's reach), 090200 (the request desk), 090300 (deferred), 090400 (letters). `access:sync` after them: `letters.issue` and `correspondence.read` to the manager.
- `apps/public` needs a `/l` page beside `/c` (the letters' check), not in this phase.
- The manager dashboard: an announcement's delivery and reminder, a request's topic and conversion, official letters, message templates, a unit's correspondence.

## Open

- A letter's own templates per compound (words beyond the three kinds), and a letter request route of the resident's own.
- Message counts per channel and month (the audit's cost row) wait for a paid channel.
- The daily brief's settings and sending (M2-4).
