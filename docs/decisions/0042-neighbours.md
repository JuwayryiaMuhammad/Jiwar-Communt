# 0042 — Neighbours: complaints between units with a notice to the unit, lost and found, the lending board, masked contact, and the welcome

**Status:** Accepted · Phase R4

## Context

Residents had no way to raise a problem about another unit, no lost and found, no lending between neighbours and no way to reach each other; a household that moved in was told nothing. This ADR adds all of it.

Out of scope: appeals to the board (R7), fines (R6), video evidence, open direct messages, a welcome between neighbours.

The model follows R2 (ADR 0039) and R3 (ADR 0040) wherever they meet: closed lists per compound, pure rules checked under a lock by the database's clock, append-only history with the one erasure UPDATE, codes instead of free text outside the content itself, every response `no-store`, every table under RLS, forced, with composite foreign keys.

Four things the brief assumed are not in the code, and are decided here: there is no building entity (a building is the free-text `units.building`, and a unit may have none); accounts have a full name and no display name; nothing announced that a household had started; and R2 has one conversation per request, no status history and no limit on open requests.

## Decisions

### A sixth domain: `src/neighbours`

It imports core and community, through community's `index.ts`, and nothing else; nothing imports it. What it reads of community is `CommunityNeighboursPort`: whether an account is one of the compound's people, the units it has a place in, a unit by its code, and who answers for a unit now.

### Complaints

- **A complaint is against a unit, never a person.** The author names it by its code, under one of the compound's categories (a closed list, eight by default, retired with `active`).
- **Never the author's own unit.** Any unit the author has a place in — an occupancy, a landlord's included, or a household membership — is refused with `OWN_UNIT`. An empty unit and an occupied one answer alike: the author learns nothing of who lives there.
- **No free text on the complaint.** What it says is its first message, as in R2; its evidence is that message's files (`complaint_evidence`: images and PDF, 10 MiB; no purpose takes a video).
- **Its number, parties and category never change** (trigger). The number is `NC-000123`, from the compound's counter row under its lock.
- **On the resident side a complaint is its author's alone**: not the unit's, not the household's. The primary does not see a family member's complaint. Everyone else gets one not-found.
- **The staff always see who complained.** There is no anonymous filing.
- **Five open complaints per author** (a setting). The counter row serializes a compound's filings, so the count and the insert are one step; a refusal rolls its number back.
- **Staff only, never a resident:** how many complaints there have been against a unit (open, resolved, dismissed, unfounded) and how an author files (total, open, dismissed as unfounded, against this same unit).

### Status

`submitted → under_review → notice_sent | mediation → resolved | dismissed`, as one table (`complaint-rules.ts`) asked after the complaint's row lock; a refusal is a 409 carrying the status found.

- Resolving and dismissing take a reason code from their own list; `unfounded` dismisses and never resolves (CHECK).
- **The author may withdraw while it is `submitted` or `under_review`**, which dismisses it as `withdrawn`. Once the unit has been told, only the staff end it.
- Every status is appended to `neighbour_complaint_status_history` (the first row is the filing), and the author is told of every change the staff make.

### Three threads

One table, `neighbour_complaint_messages`, with a `thread`: `complainant` (the author and the staff), `target` (the unit and the staff), `internal` (staff notes).

- Every read names exactly one thread and filters on it in SQL; attachments are fetched only for the messages that read selected; a resident's message view has no field for a thread. No route reads across two.
- A message never changes; the trigger lets one thing through, an erasure clearing its body.
- **The unit's thread never moves the complaint.** A message in it, and a staff note, leave `last_activity_at` alone and tell the author nothing: their complaint must not stir when the unit answers.

### The notice to the unit

- **The unit receives one thing: a notice with the category and the staff's own text.** Never the complaint's words, its evidence, its filing time or who filed it. The management decides whether and when to send it.
- **One notice per complaint** (unique index). Anything further the staff write to the unit goes in the unit's thread.
- **The notice has its own id and its own routes, and the complaint's number never reaches the unit.** Two neighbours comparing a shared number would name the complainant. The unit's notifications target the notice and carry the category's key alone.
- **Who it goes to** is decided under the unit's lock and written down (`neighbour_complaint_notice_recipients`): the household's primary and whoever holds a live `household` delegation (ADR 0016); with nobody primary, everyone living there by an occupancy; with nobody living there, its owners. A unit with nobody at all has no one to send it to (409).
- **Each recipient reads it only while they still answer for the unit in that capacity.** A household that moved out, or a delegate whose delegation ended, gets the not-found; the next household never sees it.
- Sending it moves a complaint under review to `notice_sent`; one in mediation stays there.
- The unit's routes are gated by `units.read`: receiving a notice does not depend on being allowed to complain.

### The boards

Two compound-wide boards on one table, `neighbour_posts`: lost and found (`lost`, `found`) and lending (`lend`, `borrow`). A post is a few words, a place, a day and up to three photos (`neighbour_post_photo`: images, 5 MiB).

- **A resident's post shows the building it was posted from and never a name**, a unit or an account id. The staff post lost and found items as the management.
- **Expiry is a read-time predicate** on a stored `expires_at` (thirty days for lost and found, fourteen for lending, both settings, taken when the post is written). No job closes a post. Its author keeps seeing it; the desk sees it flagged.
- **Five posts on the boards per author** (a setting), counted under the account's quota lock.
- **A found item is held at the office.** A resident claims it, with a note for the staff alone; the staff decline, or record the handover — to a claimant or to a resident who came without a claim; by whom and when; once per post — which closes the post and declines whoever else was waiting. Every write takes the post's row, so a claim and a handover are decided one at a time.
- The staff read both boards and take any post down with a reason code. **Lending has no payments, deposits or return tracking.**

### Masked contact

- **A conversation exists only on a board post**, between its author and one responder; one per post and responder; never on the management's post or one's own. Text only.
- **Each side is "a resident of building X" to the other until BOTH agree to show names**, and then a first name and nothing more (`firstNameOf`, as ADR 0031 shows a stranger). No view has a field for an account id, a full name, a phone, an email or a unit of the other side; a message is `mine` or not and has no sender.
- An agreement may be taken back until the other side agrees; after that names stay shown (trigger).
- **Ten new conversations per account in 24 hours** (a setting), counted under the account's quota lock.
- **Blocks.** Either side may block the other, from a conversation. The block and a new conversation between the same two take one advisory lock on the pair, so they are decided one at a time. From then on neither starts a conversation with the other, whichever blocked, and **neither sees the other's posts**: a hidden post answers the ordinary not-found, so masked identities cannot be linked through a refusal. What was open between them closes. The blocked side is told nothing; a closed conversation never says why. The blocker's list shows a building and a date.
- **The staff read no conversation.** A participant's report closes it, with the same neutral state, and opens a case that shows the staff that one conversation, with its two sides by name, **while the case is open**. Every reading is audited. Closing the case, with an outcome code, seals the conversation again; `post_removed` takes the post down in the same transaction.

### The welcome

- Community now announces that a household started: `AccountLifecycle.onHouseholdStarted`, called in the transaction that made it so — an occupancy created as the primary of a unit nobody lived in, or an owner alone in their own unit made its primary. A primary handed over inside a household that goes on is not a start.
- Its primary gets one inbox notice, pushed like any other, pointing at the compound's welcome: rules, office hours and emergency numbers, in English, Arabic or both (a language is whole or absent). **Once per household**: a unique index on the occupancy.
- Managers may turn it off; an empty template greets nobody. No neighbour is told anything.

### Permissions

`neighbours.complain` and `neighbours.board` default to residents and family members; `neighbours.handle` (complaints, the desk, reported conversations) and `neighbours.manage` (categories, limits, the welcome) to the manager. No default staff role holds either. They are role permissions, as in R2, not household grants.

### Notifications

One new category, `neighbours`; twenty-three kinds; nothing critical. Params are a complaint's number, a category's key or a post's kind, and nothing else. Each kind has its English and Arabic push text, with no name and no building.

### Privacy and audit

- Audit rows carry ids, keys, statuses, counts and reason codes. Never a complaint's or a post's words, a notice's text, a note or a message; a conversation's rows name the conversation and its post, never its other side.
- **Erasure**, as in R2: the person's words go and the rows stay — the bodies of their complaint and conversation messages; the words, place and photos of the posts they wrote as a resident, which close; their notes on a claim or a report. Their conversations close and their blocks are deleted. What the staff wrote stays, and so does a complaint's evidence.
- **Leaving:** someone with no place left in the compound has no post on a board and no open conversation. Their complaints stay with the staff.
- **Export** (`neighbours`): the account's complaints with its own thread, the notices it still answers for, its posts, claims, blocks and its side of each conversation. A sender is `mine` or not; the other side's messages are a count; no first name, even once shown.

## Consequences

- A sixth domain, with `neighbours` in the lint boundaries; it may import community only.
- Four permissions; existing compounds get them from `pnpm access:sync`, as before.
- Nineteen tables in six migrations (`20261020090000` to `20261020090500`); 62 routes.
- Core gains `onHouseholdStarted`, and the two-language text rule moves from engagement to `src/core/common/localized.ts`.
- `files_content_type_for_purpose` and `files_size_for_purpose` are recreated for the two purposes.
- The manager dashboard gains complaints, the lost-and-found desk, reported conversations and the neighbours setup.

## Open

- The staff learn who a notice went to only after sending it; there is no preview.
- A handler cannot list retired categories (that list needs `neighbours.manage`), so the inbox filter offers active ones only.
- The walk-in handover takes an account id; there is no resident search for a handler without `residents.read`.
- Complaints have no assignee: every holder of `neighbours.handle` is told.
- A recipient of a notice needs `neighbours.complain`, `neighbours.board` or `neighbours.handle` to attach a file to their answer; text needs none.
