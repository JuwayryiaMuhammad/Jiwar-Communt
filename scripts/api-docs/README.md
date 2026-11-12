# API documentation generator

`pnpm api-docs` writes everything under `docs/api/` that is not the contract itself:

- `docs/api/<audience>/` - a README and one Markdown file per section, for `resident`, `manager`, `guard`, `technician`, `contractor`, `partner`, `platform` and `public`;
- `docs/api/postman/<audience>.postman_collection.json` - a Postman collection (v2.1) per audience, and `jiwar.postman_environment.json`;
- `docs/api/README.md` - the index, the counts and the "needs review" list.

Nothing in those files is written by hand: change the generator, run it again. They are not committed (`.gitignore`): each run writes them from the code it runs on, and its README names that commit. Run it after a phase lands, then share the folders.

## What it does

1. **Contract.** Runs `pnpm openapi:export` and `pnpm postman:export` and reports whether the files differ from the committed ones. The environment variables the app validates default to the placeholders of `.env.example`; no database, Redis or SMTP is needed (preview mode). `--skip-export` uses the contract files as they are.
2. **Controllers** (`extract-routes.ts`). Boots the module graph in preview mode and reads each route's decorators: `@RequirePermissions`, `@RequireAnyPermission`, `@Public`, `@PlatformAuth`, `@Idempotent`, plus the permission catalog and the default roles (ADR 0010). It writes `node_modules/.cache/api-docs/routes.json`.
3. **Documentation** (`generate.ts`). Joins the contract and the routes, decides the audiences (`audiences.ts`), groups the operations into sections (`sections.ts`) and writes the files (`markdown.ts`, `readme.ts`, `postman.ts`). Examples come from the schemas (`schema.ts`); error codes in a description get their status from the source (`error-codes.ts`).

The run fails when an operation has no audience, when an operation falls in an "Other" section, or when a Postman collection fails its structural checks. The same source gives byte-identical output.

## Changing a placement

- **Audience** of a route with a permission: it follows the default roles that hold the permission (`ROLE_AUDIENCE` in `audiences.ts`). A route with no permission follows `RESIDENT_ONLY_ACCOUNT_ROUTES`, `STAFF_ACCOUNT_ROUTES` or, under `/me`, goes to every signed-in audience. A public route follows `PUBLIC_EXTRA` besides `public/`. A route that asks for `units.read` alone is a unit member's own (their household, invoices, documents): it goes to `resident/`, and to `manager/` as well only when the manager's dashboard calls it, which `dashboard-calls.ts` reads from `apps/manager` (the owner's decision, 2026-11-12).
- **Section** of a route: the first matching rule in `sections.ts` for its audience.
- A new controller needs no change when its permissions are held by a default role and its tag or path fits a section; otherwise the run prints it as "no section".
