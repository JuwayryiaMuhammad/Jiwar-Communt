/**
 * The README of each audience folder and the index at `docs/api/README.md`.
 * The text is the shared basics (written once here); the tables are derived.
 */
import type { Audience, PermissionCatalog } from './audiences';
import { servesAudience } from './audiences';
import { AUDIENCE_LABEL } from './markdown';
import type { Operation } from './model';

export interface SectionSummary {
  number: string;
  slug: string;
  title: string;
  blurb: string;
  count: number;
}

export interface AudienceSummary {
  audience: Audience;
  ops: Operation[];
  sections: SectionSummary[];
}

const WHO: Record<Audience, string> = {
  resident:
    'Residents, household members with a login (`family`) and unit proxies (`proxy`): the resident app.',
  manager:
    "The management and the compound staff who work in the manager's dashboard: the manager, the security and maintenance supervisors, the accountant and the collector (the default roles of ADR 0010; a compound can add its own roles).",
  guard:
    "Gate guards (the `staff` account with the `guard` role): the gate app, and the guard's own work.",
  technician:
    'Maintenance technicians (the `staff` account with the `technician` role): the field app.',
  contractor:
    "A vendor's contractors (account type `contractor`, tied to one vendor, ADR 0088), and a company answering a tender from its bid link.",
  partner:
    'Service partners (providers): they answer requests on a desk opened from a link, with no sign-in.',
  platform:
    'The platform owner (super admin) of Jiwar, who creates and suspends compounds. Not a compound account.',
  public:
    'Anyone, with no sign-in: links the compound sends, document checks, registration.',
};

const OTP_SIGN_IN = `1. \`POST /auth/otp/request\` with the email (or the phone) in \`identifier\`: a 6-digit code is sent by email.
2. \`POST /auth/otp/verify\` with the code: returns a login ticket and the accounts the person can pick (the same person can have accounts in more than one compound).
3. \`POST /auth/select-account\` with the ticket and the account: returns \`accessToken\` and \`refreshToken\`. Send \`X-Jiwar-Install-Id\` with it (a UUID made once per install); without it every login looks like a new browser and raises an "unusual login" alert.
4. Every request after that: \`Authorization: Bearer <accessToken>\`.
5. When the token expires (401): \`POST /auth/refresh\` with the \`refreshToken\`. Sign out: \`POST /auth/logout\`.`;

const SIGN_IN: Record<Audience, string> = {
  resident: OTP_SIGN_IN,
  manager: OTP_SIGN_IN,
  guard: OTP_SIGN_IN,
  technician: OTP_SIGN_IN,
  contractor: OTP_SIGN_IN,
  partner: `A partner has **no sign-in**. The management sends a link to the partner's desk (\`/p#<token>\`, a page of \`apps/public\`). The page sends the link's token in the body of \`POST /public/partner-desk/lookup\`, then answers requests with the \`/public/partner-desk/requests/{id}/...\` routes. A dead or revoked link answers 404 \`PARTNER_DESK_NOT_FOUND\`.`,
  platform: `1. \`POST /platform/auth/login\` with the owner's email and password: returns an \`accessToken\`, and a \`refreshToken\` when the \`scope\` is \`full\`.
2. A first login (or a reset) returns the restricted scope \`password_change\`: only \`POST /platform/auth/change-password\` accepts that token. It returns a full-scope pair.
3. Every request after that: \`Authorization: Bearer <accessToken>\`. This is a different token from a compound's: a compound token fails here, and a platform token fails on the compound routes.
4. \`POST /platform/auth/refresh\` with the \`refreshToken\`; \`POST /platform/auth/logout\` to sign out.
5. Sensitive actions (the payment gateway) need a step-up: \`POST /platform/step-up\` emails a code, \`POST /platform/step-up/verify\` accepts it on this session.`,
  public: `Nothing here needs a token, except where a link carries one in the body (a visitor pass, a tender bid, a partner desk, a registration status link). The sign-in routes (\`/auth/...\`) are listed so a client can build the login screen; the same routes are in the Auth section of every signed-in audience.`,
};

/** Permission -> account types, default roles and the endpoints that ask for it. */
function permissionRows(
  catalog: PermissionCatalog,
  ops: Operation[],
  audience: Audience,
): string[] {
  const used = new Map<string, number>();
  for (const op of ops) {
    for (const p of [...op.route.all, ...op.route.any]) {
      // Only the permissions this audience's users can hold (an "any of" list
      // names permissions of several audiences).
      if (servesAudience(p, audience, catalog))
        used.set(p, (used.get(p) ?? 0) + 1);
    }
  }
  if (used.size === 0) return [];
  const rows = [...used.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([perm, n]) => {
      const def = catalog.permissions[perm];
      const kinds = def?.derived
        ? 'a sitting board member (derived)'
        : (def?.kinds ?? []).join(', ');
      const roles = catalog.roles
        .filter((r) => r.permissions.includes(perm))
        .map((r) => r.key);
      return `| \`${perm}\` | ${kinds || '-'} | ${roles.length ? roles.join(', ') : '-'} | ${n} |`;
    });
  return [
    '| Permission | Account types it may be given to | Default roles holding it | Endpoints |',
    '|---|---|---|---|',
    ...rows,
  ];
}

const HEADERS = `| Header | When | Why |
|---|---|---|
| \`Authorization: Bearer <token>\` | Every request except the public ones | The account and the compound are inside the token |
| \`Idempotency-Key\` | The endpoints that list it | An id the client makes (8 to 128 characters from \`A-Z a-z 0-9 . _ : -\`; a UUID is fine). The same key again within 24 hours returns the first answer and repeats nothing. The same key with a different request: 409 \`IDEMPOTENCY_CONFLICT\` |
| \`X-Jiwar-Install-Id\` | \`POST /auth/select-account\` | Tells the device apart in login alerts |
| \`Accept-Language\` | Optional | The language of messages; the saved language is changed with \`PATCH /me/locale\` |`;

const ERRORS = `\`\`\`json
{
  "statusCode": 409,
  "code": "COMMUNITY_EVENT_FULL",
  "message": "English, for developers only",
  "params": { "remaining": 0 },
  "fields": [{ "field": "units.0.unitId", "code": "INVALID_FORMAT", "params": {} }],
  "details": {},
  "requestId": "…",
  "timestamp": "2026-11-10T09:00:00.000Z",
  "path": "/api/v1/…"
}
\`\`\`

- **\`code\` is always there** and is what a client reads to choose the message. \`message\` is English for developers: do not show it to a user.
- **\`fields\`:** the validation errors, one per field (400).
- **\`params\`:** the numbers a message needs, such as a limit or what is left.
- **The general codes:** 400 \`VALIDATION_FAILED\`, 401 \`UNAUTHENTICATED\`, 403 \`FORBIDDEN\`, 404 \`NOT_FOUND\`, 409 \`CONFLICT\`, 413 \`PAYLOAD_TOO_LARGE\`, 429 \`RATE_LIMITED\`, 503 \`NOT_READY\`. Most endpoints also have their own codes, listed in the Errors table of each endpoint (taken from its description).`;

const PAGINATION = `Paged lists take \`?cursor=&limit=\` (the default \`limit\` is 20, at most 100). The answer is always:

\`\`\`json
{ "data": [ … ], "nextCursor": "opaque or null" }
\`\`\`

Send \`nextCursor\` unchanged as \`cursor\` to get the next page. \`null\` means the last page. A bounded list always has \`nextCursor: null\`.`;

const UPLOADS = `1. \`POST /files/uploads\` with the \`purpose\` (for example \`ticket_photo\`), the content type and the size: returns a presigned PUT URL.
2. \`PUT\` the file to that URL directly (not to the API).
3. \`POST /files/{id}/finalize\`.
4. Send the file \`id\` in the field that asks for it (\`photoFileIds\`, \`licencePhotoFileId\`, ...).

The purpose decides which content types and sizes are accepted (\`FILE_TYPE_NOT_ALLOWED\`, \`FILE_TOO_LARGE\`).`;

const GOOD_TO_KNOW = `- **Actions that return 204:** no body. Read the resource again afterwards.
- **Money:** a string with two decimals, such as \`"1250.00"\`, in Egyptian pounds. Do not turn it into a float.
- **Times:** \`date-time\` is ISO-8601 UTC. Local dates (\`YYYY-MM-DD\`) and clock times (\`HH:mm\`) are in the compound's time zone.
- **Text the management writes** comes as \`…En\` and \`…Ar\`. Show the reader's language when it exists, the other otherwise.
- **\`no-store\`:** a response marked so holds personal data or short-lived links: do not cache it.
- **Examples are generated from the schema:** values such as \`"string"\`, \`0\` and the UUID are placeholders, not data. The first value of an enum is the one shown.`;

const AUDIENCE_NOTES: Partial<Record<Audience, string>> = {
  resident: `### Permissions are per account, and per unit

- **"Any signed-in account":** endpoints with no permission, such as \`/me/...\`. The service checks that the data is the caller's.
- **Per unit:** the primary resident of a unit gives permissions to household members. Read \`GET /me/units/{unitId}/capabilities\` and \`GET /me/units/{unitId}/permissions\` and show buttons from them; do not rebuild the rules in the app.
- **An id that is not yours** answers 404 with the resource's own code, exactly like an id that does not exist.
- **Sensitive actions (step-up):** \`POST /me/step-up\`, then \`POST /me/step-up/verify\` with the emailed code, then the action itself on the same session within 10 minutes. One code opens one action.
- **A board member's work** (\`/board/...\`) needs \`governance.board\`, which comes from the board seat and not from the role; it is in the Governance file.`,
  manager: `### Permissions are per role

- The dashboard shows what the signed-in role's permissions open. The table below lists the default roles; a compound can change them (\`roles.manage\`), so read the account's real permissions from \`GET /me\` (its \`permissions\` list) instead of assuming the default.
- Many routes also check the resource: for example a sensitive ticket is hidden from a reader without \`tickets.sensitive\`.
- Endpoints that a resident also reaches (the unit routes under \`units.read\`) are listed here too, because the manager role holds the permission; the service narrows them to what the caller may see.
- **Sensitive actions (step-up):** \`POST /me/step-up\`, then \`POST /me/step-up/verify\`, then the action on the same session within 10 minutes.
- **Needs review:** endpoints placed here because their audience was unclear are listed in the [index README](../README.md#needs-review).`,
  guard: `### Gate work happens inside a shift

- Gate actions need \`gate.operate\` and are done inside a shift: \`POST /gate/shifts/start\` opens one, and without an open shift the answer is \`NO_OPEN_SHIFT\` (each endpoint lists its own codes).
- **Offline:** the guard's phone enrols as a gate device, downloads a signed bundle on shift and uploads its actions in signed, ordered batches when it is back online. Those device routes take **no** \`Idempotency-Key\`: the client ids, the batch id and the sequence numbers do that job. See [offline](../notes/offline.md).
- Colleagues appear by first name, never by phone.`,
  technician: `### Field work

- The technician works the tickets assigned to them (\`tickets.work\`). Going on duty is \`POST /technician/availability\`; sharing a location needs the technician's consent (\`/technician/location-consent\`), see [field team](../notes/field-team.md).
- A contractor uses the same \`/technician/tickets/...\` routes on the tickets its vendor took; they are listed in the contractor folder too.`,
  contractor: `### One vendor

- A contractor sees only its own vendor's dispatches, contracts, invoices and tenders. It reaches nothing else of the compound, and nothing of a resident beyond what its ticket shows.
- A company answering a tender uses its **bid link** (no sign-in): \`/public/tender-bids/...\`. The link's token goes in the body.
- Once a dispatch is accepted, the ticket is worked through the technician routes (\`/technician/tickets/{id}\`); see [contractors and tenders](../notes/contractors-tenders.md).`,
  partner: `### The desk

- The desk link's token travels in the request body. A dead or revoked link answers 404 \`PARTNER_DESK_NOT_FOUND\`; public routes can answer 429 \`RATE_LIMITED\`.
- The management can answer for a partner from the manager dashboard (\`/staff/partner-requests\`); those routes are in the manager folder.`,
  platform: `### Platform routes

- Platform tokens are separate from compound tokens (a different secret and audience). A platform request still checks on every call that the admin is active and the session is live.
- Compound payment credentials are secret: \`PUT /platform/tenants/{id}/payment-gateway\` needs a step-up and the credentials are returned masked, never in full.`,
  public: `### Public routes

- They can be rate limited per address (and per link token where one is used): 429 \`RATE_LIMITED\`.
- A link token is the fragment of the link the compound sent. Anything that is not a live link answers 404 with the page's own code (for example \`VISITOR_PASS_NOT_FOUND\`).
- Webhooks (the payment provider, gate alarms and calls) are server-to-server and are not part of the contract.`,
};

export function audienceReadme(
  summary: AudienceSummary,
  catalog: PermissionCatalog,
  sha: string,
): string {
  const { audience, ops, sections } = summary;
  const label = AUDIENCE_LABEL[audience];
  const out: string[] = [];
  out.push(
    `<!-- Generated by \`pnpm api-docs\` from main@${sha}. Do not edit by hand. -->`,
    '',
  );
  out.push(`# ${label} API - Jiwar`, '');
  out.push(WHO[audience], '');
  out.push(
    `- **Source:** generated from \`docs/api/openapi.v0.json\` and from the permission decorators of the controllers, on main \`${sha}\`. If the code changes, run \`pnpm api-docs\` again; do not edit these files by hand.`,
    '- **The API is v0 (a draft):** paths and fields can change with the design (ADR 0025, [`v0-notes.md`](../v0-notes.md)).',
    `- **Count:** ${ops.length} endpoints in ${sections.filter((s) => s.count > 0).length} files.`,
    `- **Postman:** [\`../postman/${audience}.postman_collection.json\`](../postman/${audience}.postman_collection.json), with the shared [environment](../postman/jiwar.postman_environment.json).`,
    '',
  );
  out.push(
    '## Files',
    '',
    '| File | Endpoints | What is in it |',
    '|---|---|---|',
  );
  for (const s of sections.filter((x) => x.count > 0)) {
    out.push(
      `| [${s.title}](${s.number}-${s.slug}.md) | ${s.count} | ${s.blurb.replace(/\|/g, '\\|')} |`,
    );
  }
  out.push('', '## Basics', '', '### Base URL', '');
  out.push(
    'Every path is under `<API_HOST>/api/v1`. In the files the path is written in full (`/api/v1/...`); in the index tables it is without `/api/v1`.',
    '',
  );
  out.push(
    audience === 'platform'
      ? '### Sign-in'
      : audience === 'partner' || audience === 'public'
        ? '### Access'
        : '### Sign-in (the endpoints are in the first file)',
    '',
  );
  out.push(SIGN_IN[audience], '');
  out.push('### Headers', '', HEADERS, '');
  const perms = permissionRows(catalog, ops, audience);
  out.push('### Permissions and who holds them', '');
  if (perms.length) {
    out.push(
      'Each endpoint says which permission it needs, which account types can hold it and which default roles do (ADR 0010). "Any signed-in account" means no permission is needed.',
      '',
      ...perms,
      '',
    );
  } else {
    out.push('No endpoint here needs a permission.', '');
  }
  const extra = AUDIENCE_NOTES[audience];
  if (extra) out.push(extra, '');
  out.push('### Error shape', '', ERRORS, '');
  out.push('### Pagination (cursor)', '', PAGINATION, '');
  if (
    audience !== 'public' &&
    audience !== 'partner' &&
    audience !== 'platform'
  ) {
    out.push('### File upload', '', UPLOADS, '');
  } else if (audience === 'public') {
    out.push(
      '### File upload',
      '',
      "Registration and bid documents use their own upload routes (`/public/registrations/uploads`, `/public/tender-bids/uploads`): the same three steps (presigned PUT, `PUT` the file, finalize), with the link's token in the body.",
      '',
    );
  }
  out.push('### Good to know', '', GOOD_TO_KNOW, '');
  return out.join('\n');
}

export interface RootInput {
  sha: string;
  total: number;
  audiences: AudienceSummary[];
  review: { op: Operation; reason: string }[];
  /** Sum over audiences, to show the overlap. */
  placements: number;
  contractDrift: { openapi: boolean; postman: boolean } | null;
}

export function rootReadme(input: RootInput): string {
  const out: string[] = [];
  out.push(
    `<!-- Generated by \`pnpm api-docs\` from main@${input.sha}. Do not edit by hand. -->`,
    '',
  );
  out.push('# Jiwar API documentation', '');
  out.push(
    `The API of Jiwar Community Backend, one folder per kind of user. Generated from main \`${input.sha}\`.`,
    '',
    '- **The contract:** [`openapi.v0.json`](openapi.v0.json) and the [Postman collection of the whole API](jiwar.postman_collection.json), both written by `pnpm openapi:export` and `pnpm postman:export`.',
    '- **Per audience:** a folder of Markdown files, and a Postman collection in [`postman/`](postman/) with one shared [environment](postman/jiwar.postman_environment.json).',
    '- **Background:** [`v0-notes.md`](v0-notes.md) and the [design notes](notes/); the decisions are in `docs/decisions/` (ADR 0010 for roles and permissions).',
    '- **Regenerate:** `pnpm api-docs`. Everything below is rewritten; do not edit it by hand.',
    '',
  );
  out.push(
    '## Audiences',
    '',
    '| Audience | Who | Endpoints | Folder | Postman |',
    '|---|---|---|---|---|',
  );
  for (const a of input.audiences) {
    out.push(
      `| ${AUDIENCE_LABEL[a.audience]} | ${WHO[a.audience]} | ${a.ops.length} | [\`${a.audience}/\`](${a.audience}/README.md) | [\`${a.audience}.postman_collection.json\`](postman/${a.audience}.postman_collection.json) |`,
    );
  }
  out.push('');
  out.push('## Counts', '');
  out.push(
    `- **The contract has ${input.total} operations.** Every one has at least one audience (checked on every run).`,
    `- An endpoint that serves more than one audience is listed under each, so the audience counts add up to ${input.placements}, more than ${input.total}.`,
    "- **How the audience is decided:** from the code, not by hand. The permissions a controller demands (`@RequirePermissions`, `@RequireAnyPermission`) are looked up in the permission catalog and the default roles (ADR 0010): the roles that hold them decide the audience. A route marked `@Public()` goes to **public** (plus the audience whose flow it is, such as the tender bid link for contractors); a `@PlatformAuth()` route goes to **platform**; a route with no permission (`/me/...`) is every signed-in audience's own account endpoint, unless it is a resident-only one.",
    '',
  );
  out.push('| Audience | Endpoints |', '|---|---|');
  for (const a of input.audiences)
    out.push(`| ${AUDIENCE_LABEL[a.audience]} | ${a.ops.length} |`);
  out.push(`| **Operations in the contract** | **${input.total}** |`, '');
  out.push('## Needs review', '');
  out.push('<a id="needs-review"></a>');
  if (input.review.length === 0) {
    out.push(
      '',
      'No endpoint was placed by a guess: every one has an audience from its permissions or from a rule for its path.',
      '',
    );
  } else {
    out.push(
      '',
      `${input.review.length} endpoints are in \`manager/\` although their audience is not clear from the code alone. Each is also in the folders where it is certain; it stays in \`manager/\` so that nothing is hidden from a caller the permissions allow. Say which audience is right and the rule in \`scripts/api-docs/audiences.ts\` changes.`,
      '',
      '<details><summary>The list</summary>',
      '',
      '| Method | Path | Why |',
      '|---|---|---|',
      ...input.review.map(
        (r) =>
          `| ${r.op.method.toUpperCase()} | \`${r.op.path}\` | ${r.reason} |`,
      ),
      '',
      '</details>',
      '',
    );
  }
  return out.join('\n');
}
