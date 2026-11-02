# Transfers, dues and closed units, and the market's completion (ADR 0083)

Notes for the manager dashboard and the resident app. Every route is under `/api/v1`.

## Ownership transfers (`residents.manage`)

| Route | What it does |
|---|---|
| `POST /staff/units/{unitId}/ownership-transfers` | `{ toAccountId, resides?, reasonCode, reason }` (`householdEnd`, and the words the leaving occupants are told). One pending a unit: `409 OWNERSHIP_TRANSFER_PENDING {reference}`. `Idempotency-Key`. |
| `GET /staff/ownership-transfers?status&unitId` | Newest first, paged. `owedNow` while pending: what the unit owes now, EGP. |
| `GET /staff/ownership-transfers/{id}` | One. |
| `POST /staff/ownership-transfers/{id}/approve` | `{ duesExceptionCode? }`. Nothing owed: done. Owed: `409 TRANSFER_DUES_OWED {owed}`, unless `duesExceptionCode` (`transferDuesException`) is given after a fresh `POST /me/step-up` + `/verify` (`403 STEP_UP_REQUIRED` otherwise). Done: `owedAtApproval`, `duesExceptionCode`, `newOccupancyId`. Twice: `409 OWNERSHIP_TRANSFER_NOT_PENDING {status}`. |
| `POST /staff/ownership-transfers/{id}/cancel` | `{ reasonCode }` (`ownershipTransferCancel`). |

- The approval ends every occupancy (`ownership_transferred`, kept in the unit's history), ends the household and starts the buyer's occupancy, as `POST /units/{id}/transfer-ownership` does. That route takes `duesExceptionCode` and passes the same gate.
- What is owed is finance's own amount (the clearance's): every open invoice's remainder, open disputes included.
- The staff inbox shows a pending transfer (`ownership_transfer`).

## Moves

`GET /staff/moves` and `GET /staff/moves/{id}` carry `owed` (`"0.00"` when nothing). The handover is never blocked.

## Closed units (`guard_tasks.manage`)

- `GET /staff/security/closed-units`: the units in closed mode, the longest closed first. Each has:
  - `closedSince`;
  - `lastInspection` (`taskId`, `doneAt`, `outcome`);
  - `openRequest` (an owner's inspection request);
  - `liveProxies`;
  - `round` (`id`, `dueOn`, `status` due | scheduled, `taskId`);
  - `nextRoundOn`.
- A round falls due `closedUnitRoundDays` (gate settings, 7–180, 30) after the unit closed or was last inspected. It shows in the staff inbox (`closed_unit_round`).
- Schedule it: `POST /staff/security/tasks { kind: closed_unit_inspection, unitId, roundId, guardId | gateId | zoneId }`. Taken already: `409 CLOSED_UNIT_ROUND_NOT_DUE {status}`.
- The task done settles the round; cancelled, a new one falls due.

## A unit's proxies

`POST /staff/units/{unitId}/proxies/{id}/revoke { reasonCode }` (`residents.manage`, `proxyRevokeByManagement`). The proxy and the owner who appointed it get `unit_proxy.revoked_by_management`. `ProxyView.revokeCode` is set only for these.

## Emergency entries (`guard_tasks.manage`; all no-store)

- `POST /staff/security/unit-entries` records an entry (`Idempotency-Key`):
  - `unitId`, `reasonCode` (`unitEntryReason`);
  - `enteredAt`: within 7 days;
  - `witnessIds`: one to three staff accounts, not the caller;
  - `photoFileIds?`: up to five `unit_entry_photo` files, before.

  Every active occupant and the proxies for inspections get `unit_entry.recorded` (critical).
- `GET /staff/security/unit-entries?unitId&status` lists them; `GET …/{id}` reads one.
- `POST …/{id}/report` writes the report, once (`409 UNIT_ENTRY_REPORTED`): `outcome` (`unitEntryOutcome`), `note` (1–2000), `photoFileIds` (one to five, after). The same people get `unit_entry.reported`.
- Until it is reported, it shows in the staff inbox (`unit_entry_report`).
- `GET /units/{unitId}/entries` is the unit's people's own read: the unit's occupants and its proxies for inspections. It has no staff names; anyone else gets `404 UNIT_NOT_FOUND`.

## The market's rules (`market.handle`)

- `PATCH /market/settings` takes three more settings:
  - `commercialBlocked`;
  - `allowedCategories` (one at least);
  - `maxLivePerUnit` (1–50).
- A new or edited listing, and a new shop, is refused while it breaks them:
  - `409 MARKET_COMMERCIAL_BLOCKED` (a service, or under a shop);
  - `409 MARKET_CATEGORY_NOT_ALLOWED {category}`;
  - `409 MARKET_UNIT_LISTING_LIMIT_REACHED {max}`.
- What is open stays.

## A group offer's contract

| Route | What it does |
|---|---|
| `POST /staff/group-offers/{id}/contract` | `{ finalPrice, partnerId?, reconfirmHours? }` (`market.handle`), on a confirmed offer only. At or below the group price: `contracted`. Above it: `reconfirming` until `reconfirmClosesAt`, each participant asked (`group_offer.reconfirm_requested`). |
| `POST /market/group-offers/{id}/reconfirm` | The participant stays in at the final price, once (`409 GROUP_OFFER_RECONFIRM_NOT_NEEDED`). `…/leave` declines, until the deadline. |

- After the deadline, the sweep drops whoever did not re-confirm (`group_offer.dropped`). The offer is then `contracted` or `failed`.
- The view gains `finalPrice`, `reconfirmClosesAt`, `contractedAt` and `myReconfirmNeeded`.
