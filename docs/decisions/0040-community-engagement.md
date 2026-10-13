# 0040 — Community life: announcements, works and closures, events, consultative polls, suggestions, and the daily brief

**Status:** Accepted · Phase R3

## Context

The compound's management had no way to tell residents something, and residents had no way to answer as a community: no announcements, no events, no way to ask what people think, no place for a suggestion that is not a complaint or a request. This ADR adds all of it, and a daily brief that gathers what matters to a resident today.

Out of scope: comments, formal votes (R7), payments, automatic translation, push delivery (P1).

The model follows R2 (ADR 0039) wherever the two meet: closed lists per compound, pure rules checked under a row lock by the database's clock, append-only history, sweeps that claim one item per transaction, codes instead of free text outside the content itself.

## Decisions

### A fifth domain: `src/engagement`

`src/community` already is the domain of units, households and residents, and every other domain imports it. The daily brief reads the gate, maintenance and management, which community cannot import without a cycle. So the community life is a domain of its own, `src/engagement`. Its routes and permissions keep the product's word, `community`.

It imports the other four domains only through their `index.ts`, and nothing imports it. What it reads of each is a port on the provider's side:

- `CommunityEngagementPort` (community): the places an account holds now, who an audience is at this moment, who casts a unit's vote, unit codes and names for staff views.
- `GateStatusPort` (gate): which gates exist and whether each is in service, as `GET /gates/status` tells an occupant.
- `ResidentTicketSummary` (maintenance) and `ResidentRequestSummary` (management): a count of open items and the latest one's number and status.

### Audience

- An audience is two columns on each piece of content: `audience_buildings` (empty: the whole compound) and `audience_occupancy` (`everyone`, `owners`, `tenants`). The two combine.
- The compound has no zones, and a building is the free-text `units.building`. An audience names buildings as the units name them; a building nobody's unit names is refused. A unit without a building is in whole-compound audiences only.
- **`owners`** are the active owners of a unit, landlords included, and nobody else: not a tenant, not a member of any household. **`tenants`** are the active tenants and the members of a rented unit's household. **`everyone`** is every active occupancy and every active household member.
- **It is evaluated at read time.** Nothing stores a list of people. `inAudience(place, audience)` (community) is the one rule; lists use the same rule as a query condition built from it (`audienceWhere`), and a suite checks that a list and a single read never disagree. A newcomer sees what is live from the day they arrive; someone whose occupancy ended sees nothing, in any list or by id.
- A resident who may not read something gets the resource's 404, the same as for an unknown id.

### Announcements

- Kinds: `general` and `works` (below). Priority `normal` or `important`. Only an important one may be pinned, until a date; the pin ends by itself.
- **States come from dates alone**: draft (`publish_at` null), scheduled, published, expired (a general announcement past `expires_at`), ended (works past their end), archived. Nothing runs to publish, expire or unpin: each is a read-time predicate on the database's clock.
- **Never deleted.** `archive` takes it down for good.
- **Editing after publication is allowed.** New words or files add a row to `announcement_versions` (append-only, by trigger) and move `current_version`; nothing is rewritten. `edited_at` is set when that happens after publication, and residents see "edited". A version lists the attachments it showed, so an older version still shows its own.
- **The audience and the kind are fixed once it is out**: who was told and who has read would no longer match.
- Texts are in English, Arabic or both: `title_en`/`body_en`, `title_ar`/`body_ar`. A language is whole or absent, and at least one is there. Nothing is translated.
- Attachments: images and PDFs up to 10 MiB, a new file purpose `community_attachment`, uploaded by `community.publish` or `community.suggestions`, up to five per version.

### Read counts

Management sees how many accounts and how many units opened an announcement, never who.

- `announcement_read_marks` holds `(announcement, kind, ref)` and nothing else: no account, no unit, no time. `ref` is `HMAC-SHA256(ENGAGEMENT_REF_SECRET, "read:<kind>" ‖ announcement ‖ account or unit)`.
- The same reader marks once (the primary key); two readers of one unit are one unit. A count is `count(*)` per kind. A reader's own "read" is answered by deriving their mark again.
- **Opening an announcement is not audited.** An audit row would be the list of readers this design does not keep. It is the one state change of the phase without an audit entry, and the audit-coverage suite says so.
- An erasure has nothing to remove: a mark never named the account.

### Works and closures

A kind of announcement with `works_starts_at`, `works_ends_at`, an area kind (`road`, `facility`, `gate`), optionally one of the compound's gates, and a place in the staff's words. They are in the daily brief while under way and disappear from every resident list when they end, by the clock. They take no expiry: their end is their own.

### Events

- Title and description (two languages, as above), a place, start and end, an optional capacity, attachments, an audience fixed at creation. An event is out as soon as it is written; never deleted, only cancelled.
- A resident in the audience answers `going` or `not_going`, with guests from 0 to the compound's limit (`engagement_settings.event_max_guests`, 2 by default, 0 to 20). One answer per account, changed in place, until the event starts.
- **Capacity counts every seat, guests included, and is decided under the event's row lock** (`SELECT … FOR UPDATE`, then the seats of the others, then the write). Of two answers racing for the last seat one gets it and the other is `COMMUNITY_EVENT_FULL` with the seats left. The capacity never drops below the seats taken.
- **Cancelling** needs a reason code (`communityEventCancel`), takes the same lock, and tells every active account that said `going`.
- Management sees the attendee list (name, unit, guests); residents see counts.

### Polls

Consultative only. Formal votes are R7 and will not reuse these tables.

- A question (two languages), 2 to 10 options in the question's languages, single or multiple choice, an opening and a closing time, an audience.
- **One vote per unit.** Who casts it is the community domain's rule (`mayVote`):
  - a poll put to the **owners**: any active owner of the unit, landlords included;
  - any other poll: the unit's **primary occupant**, or a household member the primary gave **`polls_vote`**, a new member permission that is not a default. In a unit nobody lives in there is no primary, so its owner votes.
  - Delegation scopes (`household`, `workers`) are untouched: the rule that they never carry governance stands.
- A vote may be **changed until the poll closes**; the new choice replaces the old.
- Before a poll opens everything may change; once open only its closing time, so that no ballot already cast changes meaning.

#### The ballot is secret against the database

The requirement: the API never links a choice to a voter, not even for management, and no query or join over the database can reconstruct who chose what.

What is stored:

- While a poll is open its ballots are in **one row**, `poll_ballot_boxes.ballots`: a JSON object from a ballot reference to the option ids chosen. The reference is `HMAC-SHA256(ENGAGEMENT_REF_SECRET, salt ‖ poll ‖ unit)`. The secret lives in the environment and never in the database; the salt is the poll's, 32 random bytes.
- Uniqueness is the reference itself: a unit has one reference in a poll, so it has one ballot; changing a vote replaces the value under the same key. Every vote takes the box's row lock, so votes of one poll go one after the other.
- Nothing next to a choice says which unit it is: no unit column, no account, no time.

Why one row and not one row per ballot. A first design had a `poll_votes` table, a row per ballot, with no unit and no timestamp. It still leaked: a ballot row's `xmin` is the transaction that wrote it, and the same transaction writes the audit entry (`poll.vote_cast`, with the unit and the actor). `JOIN … ON votes.xmin = audit_log.xmin` would have given unit to choice; `ctid` order would have given the order of voting. With every ballot in one row, rewritten whole on each vote, there is no per-ballot system column: the row's `xmin` is the last voter's alone, and JSON object keys are stored sorted, not in the order they were added.

What the end does. Closing a poll (by the staff, or by the sweep at its closing time) writes each option's `final_count` and the turnout, then **deletes the box and clears the salt**. Only then is "this unit took part" written, to `poll_participations`, for all units at once, in one transaction and in unit order, so those rows say nothing about when each unit voted. Cancelling does the same without counting anything. After the end nothing individual exists, and no reference can be derived again, with or without the secret.

What the server can do, and says. While a poll is open the running server, which holds the secret, derives a unit's reference: that is how it changes a vote, and how it tells **the people who cast that unit's vote** their unit's current choice, so they change it knowingly. It tells nobody else: no staff route carries a unit's choice or a unit's id next to an option, and a household member who does not cast the vote sees only that the unit voted. After the poll ends it can tell nobody.

So the secrecy is against a copy of the database (a dump, a replica, a query console, a compromised application role), not against the running server while a poll is open. Two more limits, stated plainly:

- Someone who can read the database **continuously** can compare the box before and after each vote and match the change to the audit entry. This is inherent in a ballot that can be changed. It needs live access to the database, not a copy.
- A superuser with page-level tools (`pageinspect`, the WAL) can read old versions of the box row before they are vacuumed. Out of scope: that is the same person who holds the server's environment.

Other places a choice could have leaked, and does not:

- **Idempotency.** A stored key holds an unkeyed hash of the request; next to the account id it would give away a ballot to anyone who tries the few bodies there can be. `@Idempotent({ bodyless: true })` leaves the body out of the hash for the vote route. A retry replays as always; the price is that the same key with another choice replays the first response instead of 409.
- **Audit.** `poll.vote_cast` records the unit and whether it was a change, never an option.
- **Counts on a small poll.** While fewer than **five units** have voted on an open poll, counts and turnout are shown to nobody, the staff included. A resident sees an open poll's counts once one of their units has voted (and five have). A closed poll shows everything to everyone, whatever the turnout: a poll with two voters that closes shows two counts. Management should not put a secret question to an audience of three.
- **Export and erasure.** An export says "voted: yes or no" per poll for the account's units. An erasure touches nothing: no account was ever stored with a ballot, and the unit's ballot stays counted.

There is no log or history of votes: one would be exactly the link this design does not keep.

Rotating `ENGAGEMENT_REF_SECRET` while a poll is open orphans the ballots already cast (those units could vote again and the first ballots would still be counted), and read marks would count readers again. Rotate it only when no poll is open.

### Suggestions and "you said, we did"

- A resident writes a suggestion under one of the compound's topics (`suggestion_topics`, a closed list, six seeded), optionally about one of their units. It is **private to its author and to the staff** who handle suggestions; nobody else finds it, by list or by id.
- It moves forward only: `received` → `under_review` → `planned` → `done`, or `declined` from any step before the end. `done` and `declined` are final. Declining needs an answer. Each move and each answer is a row of `suggestion_updates` (append-only), which the author reads as a timeline without staff names.
- **The public board.** The staff may publish a suggestion under a **summary they write** (title and text, two languages). The board shows the summary, the topic, the status and a support count; never the resident's words, their name or their unit. The summary may be rewritten; unpublishing removes it.
- Residents **support** a published suggestion, once per account, and may take it back.
- **"You said, we did"** lists done suggestions with the staff's note and photos (and the summary, when published).
- **Erasure** follows R2's message rule: the author's words go (`body` to NULL with `erased_at`; a trigger allows that one change to them and no other, and never a change of author, topic, unit or creation time), the supports they gave are deleted, and everything the staff wrote stays, the public summary included.

### The daily brief

`GET /me/daily-brief`, computed when asked and stored nowhere, in one transaction on one clock:

- works and closures under way now;
- today's events (the compound's local day) that are not over;
- announcements: what is pinned, and what came out in the last seven days that the caller has not opened;
- open polls closing within 48 hours in which the caller casts the vote of a unit that has not voted;
- the caller's unfinished tickets and open management requests: a count and the latest one's number and status, each through its own domain's port and only when the caller's role uses that feature;
- the gates and whether each is in service.

### Permissions

- `community.read` and `suggestions.create`: residents and family (a landlord is a resident account). Both are defaults of the `resident` and `family_member` roles.
- `community.publish` (announcements, works, events, polls, the event rules) and `community.suggestions` (suggestions and their topics): staff or manager. The `manager` role gets both; no default staff role gets either.
- Existing compounds get them from `access:sync`, like every permission.

### Notifications

A new category, `community`; nothing is critical. Exactly three kinds, with ids and keys for params and never a text:

- `community_announcement.important`: to the audience as it is when the announcement comes out, once. A scheduled one is told by a 60-second sweep. Whoever arrives later reads it and is not told.
- `community_event.cancelled`: to the accounts that said `going`.
- `community_suggestion.status_changed`: to the suggestion's author, on a move or an answer; params `status` and `topicKey`.

Everything else — a normal announcement, works, a new event, a poll, publishing a suggestion, a "we did" note — writes no notification at all. It is read in its own list and in the daily brief.

### Privacy and audit

- Every response is `no-store`. Every table has RLS, forced, and composite foreign keys.
- Audit entries carry ids, keys, dates, counts and reason codes. Titles, texts, places, summaries, notes and answers are recorded as "changed" or not at all. Building names are recorded by value, like unit codes: they are the compound's own labels.
- The export gains a `community` section: the account's suggestions with the staff's answers, the suggestions it supports, its answers to events, and "voted: yes or no" per poll for its units.
- An erasure clears the account's suggestion texts and deletes its supports and its answers to events.

### Jobs

Two sweeps, every 60 seconds, each one transaction per item with `SKIP LOCKED`: `engagement.announce` and `engagement.poll_close`. Nothing else is scheduled.

## Consequences

- A new required secret, `ENGAGEMENT_REF_SECRET`: the app refuses to boot without it, and says how to make one. It must be set on every environment before this is deployed.
- Seven migrations (`20261019090100` to `20261019090700`, after the push migration); `access:sync` after them.
- A vote rewrites the poll's ballot box row: a few kilobytes per hundred units. Fine for a compound; not a design for a national election.
- A resident's place is read on every community request (two queries). Cheap, and the price of an audience that is never stale.
- Polls do not survive the loss of the secret while open; closed polls are unaffected.

## Open

- An answer to an event stays when its account leaves the compound (the seat stays taken until the staff see it in the list). Decide with the design whether leaving frees the seat.
- Changing an event's time or place tells nobody; only a cancellation does.
- A suggestion's author is not asked before the staff publish a summary of it. The summary is the staff's words and names nobody; decide whether the author should be told.
- The dashboards mirror reason lists by hand; a unit test now checks `communityEventCancel` against the service and the CHECK, the older lists are not checked.
