/**
 * Which audiences an operation serves.
 *
 * Authority is the code, not this file: a route's audience is derived from the
 * permissions its controller demands (`@RequirePermissions` /
 * `@RequireAnyPermission`), the account kinds the catalog lets hold them and
 * the default roles that hold them (ADR 0010). Only what a decorator cannot
 * say lives here: routes with no permission (the account's own `/me/...`) and
 * the public routes that belong to one audience's flow.
 */

export const AUDIENCES = [
  'resident',
  'manager',
  'guard',
  'technician',
  'contractor',
  'partner',
  'platform',
  'public',
] as const;
export type Audience = (typeof AUDIENCES)[number];

/** Audiences whose users sign in with a tenant access token. */
export const TOKEN_AUDIENCES: Audience[] = [
  'resident',
  'manager',
  'guard',
  'technician',
  'contractor',
];

export interface RouteFacts {
  method: string;
  /** Without the `/api/v1` prefix. */
  path: string;
  public: boolean;
  platform: boolean;
  all: string[];
  any: string[];
}

export interface PermissionCatalog {
  permissions: Record<string, { kinds: string[]; derived: boolean }>;
  roles: { key: string; kind: string; permissions: string[] }[];
}

/** The default role -> the audience that works with it. */
const ROLE_AUDIENCE: Record<string, Audience> = {
  resident: 'resident',
  family_member: 'resident',
  unit_proxy: 'resident',
  manager: 'manager',
  // Compound staff who work in the manager's dashboard.
  security_supervisor: 'manager',
  maintenance_supervisor: 'manager',
  accountant: 'manager',
  collector: 'manager',
  guard: 'guard',
  technician: 'technician',
  contractor: 'contractor',
};

const KIND_AUDIENCE: Record<string, Audience> = {
  resident: 'resident',
  family: 'resident',
  proxy: 'resident',
  manager: 'manager',
  staff: 'manager',
  contractor: 'contractor',
};

export interface Classification {
  audiences: Audience[];
  /** Account types that can call it (from the catalog), `[]` for no token. */
  accountTypes: string[];
  /** Default roles that hold what it needs. */
  roles: string[];
  /** Why this audience, when it was a fallback or a path rule. */
  basis: 'platform' | 'public' | 'permission' | 'account' | 'path' | 'fallback';
  /** True when the placement is a guess a person should look at. */
  needsReview: boolean;
  reviewReason?: string;
}

/**
 * Routes with no permission that serve one audience only. Everything else
 * under `/me` (profile, sessions, devices, notifications, consents, data
 * export, step-up, push tokens) is every signed-in account's own.
 */
const RESIDENT_ONLY_ACCOUNT_ROUTES: RegExp[] = [
  /^\/me\/units(\/|$)/,
  /^\/me\/delegations$/,
  /^\/me\/requests$/,
  /^\/me\/appeals$/,
  /^\/me\/search$/,
  /^\/me\/notices(\/|$)/,
  /^\/me\/gate-requests$/,
  /^\/gate-requests\/\{id\}\/decide$/,
  /^\/me\/entry-credentials(\/|$)/,
  /^\/me\/parcels(\/|$)/,
  /^\/me\/gate-calls(\/|$)/,
  /^\/me\/outages$/,
  /^\/gates\/status$/,
];

/** `/staff/...` routes any staff account reaches with no permission. */
const STAFF_ACCOUNT_ROUTES: RegExp[] = [/^\/staff\//];

/** Public routes that belong to one audience's flow, besides `public/`. */
const PUBLIC_EXTRA: { match: RegExp; audiences: Audience[] }[] = [
  { match: /^\/auth\//, audiences: TOKEN_AUDIENCES },
  { match: /^\/public\/tender-bids\//, audiences: ['contractor'] },
  { match: /^\/public\/partner-desk\//, audiences: ['partner'] },
  { match: /^\/registrations\//, audiences: ['resident'] },
  { match: /^\/public\/registrations\//, audiences: ['resident'] },
  { match: /^\/invites\//, audiences: ['resident'] },
  { match: /^\/proxy-invites\//, audiences: ['resident'] },
];

/**
 * Whether a permission is one this audience's users hold: a default role of
 * the audience has it, or (for one no default role holds) its account kinds
 * belong to the audience.
 */
export function servesAudience(
  permission: string,
  audience: Audience,
  catalog: PermissionCatalog,
): boolean {
  const def = catalog.permissions[permission];
  if (def?.derived) return audience === 'resident';
  const holders = catalog.roles.filter((r) =>
    r.permissions.includes(permission),
  );
  if (holders.length)
    return holders.some((r) => ROLE_AUDIENCE[r.key] === audience);
  return (def?.kinds ?? []).some((k) => KIND_AUDIENCE[k] === audience);
}

function sortAudiences(list: Iterable<Audience>): Audience[] {
  const set = new Set(list);
  return AUDIENCES.filter((a) => set.has(a));
}

/**
 * `managerCalls`: what the manager's dashboard calls (`dashboard-calls.ts`).
 * Without it, a `units.read` route stays in manager/ and is listed for review.
 */
export function classify(
  route: RouteFacts,
  catalog: PermissionCatalog,
  managerCalls?: ReadonlySet<string>,
): Classification {
  const { path } = route;

  if (route.platform || path.startsWith('/platform/')) {
    return {
      audiences: ['platform'],
      accountTypes: [],
      roles: [],
      basis: 'platform',
      needsReview: false,
    };
  }

  if (route.public) {
    const audiences = new Set<Audience>(['public']);
    for (const extra of PUBLIC_EXTRA) {
      if (extra.match.test(path))
        extra.audiences.forEach((a) => audiences.add(a));
    }
    return {
      audiences: sortAudiences(audiences),
      accountTypes: [],
      roles: [],
      basis: 'public',
      needsReview: false,
    };
  }

  const required = route.all.length ? route.all : route.any;
  if (required.length) {
    const mode = route.all.length ? 'all' : 'any';
    const holders = (permission: string) =>
      catalog.roles.filter((r) => r.permissions.includes(permission));
    const kindsOf = (permission: string) =>
      catalog.permissions[permission]?.kinds ?? [];

    // Roles that satisfy the route, and the account types it admits.
    const roles = catalog.roles.filter((r) =>
      mode === 'all'
        ? route.all.every((p) => r.permissions.includes(p))
        : route.any.some((p) => r.permissions.includes(p)),
    );
    let kinds: string[];
    if (mode === 'all') {
      kinds = kindsOf(route.all[0]).filter((k) =>
        route.all.every((p) => kindsOf(p).includes(k)),
      );
    } else {
      kinds = [...new Set(route.any.flatMap(kindsOf))];
    }

    const audiences = new Set<Audience>();
    for (const role of roles) {
      const a = ROLE_AUDIENCE[role.key];
      if (a) audiences.add(a);
    }
    // A permission no default role holds, or one derived from an account's
    // standing (`governance.board`: a sitting board member, who is a
    // resident, ADR 0051).
    const orphan = required.some(
      (p) => holders(p).length === 0 || catalog.permissions[p]?.derived,
    );
    let needsReview = false;
    let reviewReason: string | undefined;
    if (orphan) {
      for (const p of required) {
        if (holders(p).length > 0 && !catalog.permissions[p]?.derived) continue;
        if (catalog.permissions[p]?.derived) {
          audiences.add('resident');
          continue;
        }
        const fromKinds = kindsOf(p)
          .map((k) => KIND_AUDIENCE[k])
          .filter(Boolean);
        if (fromKinds.length === 0) {
          needsReview = true;
          reviewReason = `no default role holds \`${p}\``;
        }
        fromKinds.forEach((a) => audiences.add(a));
      }
    }
    if (audiences.size === 0) {
      audiences.add('manager');
      needsReview = true;
      reviewReason ??= 'no audience from the permissions';
    }
    if (kinds.length === 0 && mode === 'all') {
      kinds = [...new Set(route.all.flatMap(kindsOf))];
    }
    // `units.read` opens a unit's own data (its household, invoices,
    // documents) to whoever the unit is theirs. The manager role holds the
    // permission too, but these are the resident's routes: the manager
    // dashboard calls /staff/... for the same data. Such a route is the
    // manager's only when the manager's dashboard calls it (the owner's
    // decision, 2026-11-12).
    if (
      mode === 'all' &&
      route.all.length === 1 &&
      route.all[0] === 'units.read' &&
      audiences.has('manager')
    ) {
      if (!managerCalls) {
        needsReview = true;
        reviewReason =
          "a unit member's own route: the manager role holds `units.read`, but the manager dashboard uses the `/staff/...` routes for this data";
      } else if (!managerCalls.has(`${route.method} ${path}`)) {
        audiences.delete('manager');
        audiences.add('resident');
      }
    }
    return {
      audiences: sortAudiences(audiences),
      accountTypes: kinds,
      roles: roles.map((r) => r.key),
      basis: 'permission',
      needsReview,
      reviewReason,
    };
  }

  // No permission: any signed-in account of the right kind.
  if (RESIDENT_ONLY_ACCOUNT_ROUTES.some((re) => re.test(path))) {
    return {
      audiences: ['resident'],
      accountTypes: ['resident', 'family', 'proxy'],
      roles: [],
      basis: 'account',
      needsReview: false,
    };
  }
  if (STAFF_ACCOUNT_ROUTES.some((re) => re.test(path))) {
    return {
      audiences: ['manager'],
      accountTypes: ['manager', 'staff'],
      roles: [],
      basis: 'account',
      needsReview: false,
    };
  }
  if (path === '/me' || path.startsWith('/me/')) {
    return {
      audiences: [...TOKEN_AUDIENCES],
      accountTypes: [
        'resident',
        'family',
        'proxy',
        'manager',
        'staff',
        'contractor',
      ],
      roles: [],
      basis: 'account',
      needsReview: false,
    };
  }
  return {
    audiences: ['manager'],
    accountTypes: [],
    roles: [],
    basis: 'fallback',
    needsReview: true,
    reviewReason: 'no permission and no rule for the path',
  };
}
