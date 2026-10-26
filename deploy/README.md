# Staging deploy

`http://191.218.163.45` (no domain, plain HTTP). The host also runs other
projects (nginx sites, a host Postgres 16 and Redis, n8n). This stack shares
none of them: its own containers, nothing listening outside 127.0.0.1.

## Flow

1. A push to `main` runs CI (`.github/workflows/ci.yml`).
2. When CI passes, `.github/workflows/deploy.yml` builds four images and
   pushes them to `ghcr.io/juwayryiamuhammad/jiwar-communt`: the API as
   `<sha>`, the dashboards (`apps/Dockerfile`) as `<sha>-admin` and
   `<sha>-manager`, the public web pages as `<sha>-public`. It can also be run by hand (Actions → Deploy → Run
   workflow), on `main` only.
3. It connects as `jiwar-deploy` and runs `deploy <sha>`, the job's token on
   stdin. That key is bound to `/usr/local/bin/jiwar-community-deploy`
   (`deploy/deploy.sh`) with `command=…,restrict`: no shell, no forwarding.
4. The script pulls the images, takes `compose.yml` from the API's, then
   runs the README's deploy order: `prisma migrate deploy` as
   `jiwar_migrator`, `access:sync`, the bucket, and only then the app, both
   dashboards and the public web pages, waiting for their health checks. If one is not healthy,
   the previous release goes back up. Migrations are not undone.

## CI

`.github/workflows/ci.yml` (ADR 0026), four jobs on every pull request and push to `main`; `ci` passes only when the other three did, and is the check branch protection requires.

- **`static`**: install, `pnpm migrations:check` (ADR 0061), migrate the dev database as `jiwar_migrator`, `access:sync`, prisma validate, lint, type-check, build, unit tests, the OpenAPI contract and the dashboards' client types current, the dashboards' type-check, tests and builds.
- **`e2e`**: four shards by suite duration, each with its own Postgres, Redis, Mailpit and MinIO.
- **`migrate-with-data`** (ADR 0061): the base commit's migrations (the merge base on a pull request, the replaced `main` on a push), its seed (two compounds with settings, a roster, devices, passes, instructions, an invoice and a payment), then the branch's migrations over it, as `jiwar_migrator` like staging. It fails on any error, a constraint left not validated, a migration unfinished or edited after it was applied, the database's FORCE RLS tables differing from the static check's, or fewer rows in a table.

**A migration that writes to a tenant table** (a backfill) runs per compound, as in `20261108090000`:

```sql
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    UPDATE "…" SET … WHERE "tenant_id" = t."id";
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
```

**Exceptions**, always with a reason:

- a statement in a new migration that is safe unscoped: `-- rls-dml-allow: <reason>` on the line above it;
- an applied migration (never edited): `prisma/migrations-rls-allow.json` → `bareDml`, `"<migration>:<line>": "<reason>"`;
- a new migration that removes rows on purpose (a dedupe, a purge): the same file → `rowsRemoved`, `"<migration>": { "tables": [...], "reason": "..." }`.

**Locally**: `pnpm migrations:check`; and against an empty scratch database (`CREATE DATABASE <scratch> OWNER jiwar_migrator`, never the dev one), after `pnpm install`:

```bash
MIGRATOR_DATABASE_URL=postgresql://jiwar_migrator:…@127.0.0.1:5435/<scratch> SUPERUSER_DATABASE_URL=postgresql://postgres:…@127.0.0.1:5435/<scratch> test/migrate-with-data/run.sh origin/main
```

## Dashboards

`admin` and `manager` are services of the same stack (`deploy/compose.yml`),
so they ship, roll back and are pruned with the API:

| Service | Container | Listens on | Image | Environment |
|---|---|---|---|---|
| `admin` | `jiwar-community-admin-1` | `127.0.0.1:3001` | `<sha>-admin` | `PORT=3001`, `JIWAR_API_URL=http://app:3100` |
| `manager` | `jiwar-community-manager-1` | `127.0.0.1:3002` | `<sha>-manager` | `PORT=3002`, `JIWAR_API_URL=http://app:3100` |

`NODE_ENV=production` and `HOSTNAME=0.0.0.0` come from the image
(`apps/Dockerfile`). They need no env file: they hold no secret. Each has a
health check (its `/login` page answers) and a 256 MB memory limit; a deploy
waits for both to be healthy, and puts the previous release back if one is
not.

The names, ports and environment are the ones the hand-built containers
already use (compose project `jiwar-community`, built from `31e2fe8`), so the
first deploy replaces those two containers in place.

### nginx and HTTPS: on the server, not in this repository

The two names are served by nginx server blocks that certbot manages on the
server. **Nothing in this repository installs or replaces them**, and
`deploy/nginx.conf` (the API's default server on port 80) does not mention
them. For reference, what is live:

| Name | Listens | Certificate | Proxies to |
|---|---|---|---|
| `community-admin.escanestate.com` | 443 (TLS) | certbot, one certificate for both names, valid to 2027-01-02, renewed by certbot | `http://127.0.0.1:3001` |
| `community-manager.escanestate.com` | 443 (TLS) | the same certificate | `http://127.0.0.1:3002` |

Both pass `Host $host` and the `X-Forwarded-*` headers. HTTPS is required,
not optional: the dashboards' session cookies are `Secure`, and the BFF
compares a request's `Origin` with the `Host` it receives, so `Host` must
stay the public name.

### Putting this change on the server

One step, by hand, as root: install the new deploy script. No nginx step, no
env file, no manual container work.

```bash
scp deploy/deploy.sh root@191.218.163.45:/tmp/jiwar-community-deploy
ssh root@191.218.163.45 'install -o root -g root -m 755 /tmp/jiwar-community-deploy /usr/local/bin/jiwar-community-deploy && rm /tmp/jiwar-community-deploy'
```

Either order works; before the merge is the simpler one.

- **Script installed before the merge.** Nothing changes until the merge's
  own deploy. That deploy pulls three images, migrates, starts the API, then
  replaces the two hand-built dashboard containers with the released ones
  and waits for all three to be healthy. Until then, do not deploy a commit
  from before this change with the new script: it would look for dashboard
  images that were never built and stop before touching anything. A
  `rollback` is unaffected (it pulls nothing).
- **Script installed after the merge.** The merge's deploy runs with the old
  script: the API is released as usual and the dashboards are left exactly
  as they are (the hand-built containers keep running; the old script starts
  `app` only). Then install the script and run the workflow again by hand
  (Actions → Deploy → Run workflow): it pulls the two dashboard images and
  replaces the containers.

Check afterwards:

```bash
ssh root@191.218.163.45 'sudo -u jiwar-deploy jiwar-community-deploy status'   # app, admin, manager: healthy
curl -sI https://community-manager.escanestate.com/login | head -1
curl -sI https://community-admin.escanestate.com/login | head -1
```

If the first deploy fails with a container name conflict, the hand-built
containers were not created by compose. Remove them and run the workflow
again (a minute without the dashboards; the API is unaffected):

```bash
ssh root@191.218.163.45 'docker rm -f jiwar-community-admin-1 jiwar-community-manager-1'
```

Rolling back to a release from before this change brings back that API and
leaves the dashboards as they are: that release has none of its own.

## Public web pages

`public` (`apps/public`) is a fourth service of the same stack: the pages the
API's links open (`/v`, `/a/not-me`, `/a/export`, and `/i`, `/r`). It ships,
rolls back and is pruned with the API.

| Service | Container | Listens on | Image | Environment |
|---|---|---|---|---|
| `public` | `jiwar-community-public-1` | `127.0.0.1:3003` | `<sha>-public` | `PORT=3003`, `JIWAR_API_URL=http://app:3100` |

No env file, no secret, no cookie. Health check: `/` answers. 256 MB.

### What the server needs, by hand

Nothing in this repository installs any of it, and none of it touches the
existing server blocks.

1. **nginx:** a new server block for `community.escanestate.com` (TLS by
   certbot, like the dashboards') with the upstream `http://127.0.0.1:3003`.
   It must pass `Host $host` (the proxy under `/api` compares a request's
   `Origin` with it) and the client address:

   ```nginx
   proxy_set_header Host $host;
   proxy_set_header X-Forwarded-For $remote_addr;   # overwritten, as in deploy/nginx.conf
   proxy_set_header X-Forwarded-Proto $scheme;
   ```

2. **`app.env`:** `PUBLIC_APP_URL=https://community.escanestate.com`, and
   `TRUST_PROXY=1` (already what `deploy/nginx.conf` assumes). A changed
   `app.env` takes effect when the app container is recreated; the next
   deploy does that.
3. **The deploy script:** install the new `deploy/deploy.sh` as in
   "Putting this change on the server" above (the same two commands). With the old script a deploy
   releases the API and the dashboards and simply does not start `public`;
   with the new script, do not deploy a commit from before this change (it
   would look for a `-public` image that was never built and stop before
   touching anything).

Check afterwards: `status` lists `public` as healthy, and
`curl -sI https://community.escanestate.com/ | head -1` answers 200.

### The client address, and why `TRUST_PROXY=1` is safe

The API's per-IP limits (20 per 15 minutes on the code and not-me routes, 60
per minute on the visitor page) count `req.ip`. With `TRUST_PROXY=1` the API
believes exactly one hop: the address its direct peer wrote last in
`X-Forwarded-For`. There are two paths to the API, and in each the API trusts
one hop, its peer:

| Path | The API's peer | `X-Forwarded-For` the API reads | Hops trusted |
|---|---|---|---|
| nginx → API (`deploy/nginx.conf`, port 80) | nginx | `$remote_addr`, overwritten by nginx | 1 (nginx) |
| nginx → `public` → API | `public` | one address: the right-most entry of what nginx sent `public` | 1 (`public`), which itself believed 1 (nginx) |

`public` never passes a chain on: whatever the browser put in
`X-Forwarded-For` is dropped and only the entry nginx wrote last goes to the
API (`apps/public/lib/proxy-rules.ts`, with a test), so appending
(`$proxy_add_x_forwarded_for`) in the block above would be safe too.

**This holds only because every path to the API goes through nginx or
through `public`.** `compose.yml` publishes the API on `127.0.0.1:3100` and
`public` on `127.0.0.1:3003`, never on `0.0.0.0`: a client that could reach
either port directly could write its own `X-Forwarded-For` and pick the
address the limits count, a fresh one per request. Keep both bindings on
localhost, and never raise `TRUST_PROXY` above 1 for this layout. The
dashboards send no `X-Forwarded-For`, so their calls count as the dashboard
container's address, as before.

### Known limit on staging: file downloads

The export page (`/a/export`) ends by opening the presigned URL the API
returns. Staging's storage is MinIO over plain HTTP
(`S3_ENDPOINT=http://191.218.163.45`), and a browser on an HTTPS page blocks
that download as mixed content. The page cannot see the block; it tells the
person that the file service may be unavailable and to try later. This
clears when storage moves to HTTPS (R2, below). Registration has no file
upload: the API has no upload path for a registrant yet (ADR 0024).

## Online payment (Paymob, ADR 0046)

Each compound may take online payment through its own Paymob account; its
manager (or the platform owner) enters the credentials in the dashboard.
The server needs three things, by hand, before the first compound switches
it on. Until then nothing changes: the app boots without them.

1. **`app.env`: the vault key.** `PAYMENT_CREDENTIALS_KEY` seals every
   compound's credentials and open checkout secrets. Generate it with
   `openssl rand -base64 32` (exactly 32 bytes; boot refuses anything else),
   **different per environment**, never equal to another key in `app.env`
   (boot refuses an equal value), kept in `app.env` only. Leave
   `PAYMENT_CREDENTIALS_KEY_VERSION` at `1` until the first rotation.
2. **`app.env`: the webhook's origin.** Paymob posts each payment's result
   to `<PAYMENT_WEBHOOK_BASE_URL>/api/v1/public/payments/paymob/<compound id>`;
   every checkout tells Paymob that address, so nothing is configured in
   Paymob's dashboard. It must be public HTTPS. On staging the API has no
   public HTTPS name, so the smallest safe option is the public web pages'
   name, with one nginx location (step 3):

   ```
   PAYMENT_WEBHOOK_BASE_URL=https://community.escanestate.com
   ```

3. **nginx: one location in `community.escanestate.com`'s server block**
   (the TLS block certbot manages, which today sends everything to the
   public web pages on 3003). Add it **inside that block, above its
   `location /`**. `^~` makes it win over `/` (and over any regex location),
   so the public app never sees these requests, and only this prefix reaches
   the API: no other API path becomes public through this name.

   ```nginx
   # Paymob's payment callbacks (ADR 0046): straight to the API, POST only.
   location ^~ /api/v1/public/payments/paymob/ {
       limit_except POST { deny all; }
       client_max_body_size 64k;
       proxy_pass http://127.0.0.1:3100;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $remote_addr;   # overwritten, as in deploy/nginx.conf
       proxy_set_header X-Forwarded-Proto $scheme;
   }
   ```

   `nginx -t && systemctl reload nginx`, then check from outside:
   `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://community.escanestate.com/api/v1/public/payments/paymob/00000000-0000-7000-8000-000000000000`
   answers `401` (refused: unknown compound, no signature) from the API, not
   the public app's 404; a `GET` answers `403` from nginx. The public app's
   own `/api` proxy has an allowlist that never includes this path (a test
   pins it), so the location above is the only way in.

**The boot rule.** Once any compound has online payment switched on (and
not switched off by the platform), the app refuses to start when
`PAYMENT_CREDENTIALS_KEY` or `PAYMENT_WEBHOOK_BASE_URL` is missing, or when
the key of a gateway's version is not in `app.env`; the error names the
variables and the compound ids. So never remove the key from an environment
that took payments.

**Rotating the key.** Set a new `PAYMENT_CREDENTIALS_KEY`, raise
`PAYMENT_CREDENTIALS_KEY_VERSION`, move the old one to
`PAYMENT_CREDENTIALS_PREVIOUS_KEYS` as `<old version>:<old key>`, deploy,
then re-seal everything with the current key (running it twice changes
nothing):

```bash
ssh root@191.218.163.45 'cd /srv/jiwar-community && docker compose -p jiwar-community run --rm --no-deps app node dist/finance/gateway/reencrypt.cli.js'
```

Then drop `PAYMENT_CREDENTIALS_PREVIOUS_KEYS` and deploy again.

The other settings have safe defaults: `PAYMOB_BASE_URL`
(`https://accept.paymob.com`), `PAYMOB_REQUEST_TIMEOUT_MS` (15000),
`PAYMENT_SESSION_TTL_MINUTES` (30), `RECEIPT_PAGE_RATE_LIMIT_PER_IP` (30).
The public receipt page is `<PUBLIC_APP_URL>/receipt#<code>` and the page
Paymob's checkout returns to is `<PUBLIC_APP_URL>/paid`: both ship with the
public web pages, nothing to install.

## Server layout

| Path | Contents |
|---|---|
| `/srv/jiwar-community/app.env` | App environment and secrets (root:jiwar-deploy 640) |
| `/srv/jiwar-community/migrator.env` | `MIGRATOR_DATABASE_URL`, seen only by the `migrate` service |
| `/srv/jiwar-community/db.env`, `minio.env` | Postgres superuser and role passwords; MinIO root |
| `/srv/jiwar-community/init.sql` | Copy of `docker/postgres/init.sql` (first start of an empty volume only) |
| `/srv/jiwar-community/current`, `previous` | Deployed SHAs |
| `/etc/nginx/sites-available/jiwar-community` | `deploy/nginx.conf`: default server on port 80, `/jiwar/` to MinIO |

`app.env` must set `PUBLIC_APP_URL` (ADR 0030, ADR 0036): visitor and email
links are built from it and the app refuses to boot without it. The image
runs with `NODE_ENV=production`, so it must be `https://`: the address of the
public web pages, `https://community.escanestate.com` (Public web pages,
above).

`app.env` must set `ENTRY_CREDENTIAL_KEY` (ADR 0031; the app refuses to boot
without it): the key every resident's entry secret is derived from. Generate
it with `openssl rand -base64 48`, give staging and production **different**
values, and never reuse `IDENTIFIER_PEPPER`'s (boot refuses an equal value).
It lives in `app.env` only, never in the repository. Leaking it forges
resident QRs in every compound; changing it makes every entry credential stop
verifying, so every phone must register again (the ADR has the rotation
procedure).

`app.env` must set `PARCEL_TOKEN_KEY` (ADR 0035; the app refuses to boot
without it): the key the token behind every parcel code and QR is derived
from. Generate it with `openssl rand -base64 48`. The rule: **different per
environment, and never equal to `IDENTIFIER_PEPPER` or `ENTRY_CREDENTIAL_KEY`**
(boot refuses an equal value). It lives in `app.env` only, never in the
repository. Whoever holds it and a credential id can compute that credential's
code; changing it strands the codes of the parcels held at that moment, which
can then only be handed over by the resident's entry QR (the ADR has the
details), so change it in a quiet hour.

`app.env` must set `ENGAGEMENT_REF_SECRET` (ADR 0040; the app refuses to boot
without it, and says so): the key behind the opaque references of the
community life, a unit's ballot while a poll is open and the marks that count
an announcement's readers. Generate it with `openssl rand -base64 48`. The
rule: **different per environment, and never equal to `IDENTIFIER_PEPPER`,
`ENTRY_CREDENTIAL_KEY` or `PARCEL_TOKEN_KEY`** (boot refuses an equal value).
It lives in `app.env` only, never in the repository or the database: it is
what keeps a database dump from telling who chose what. Changing it while a
poll is open orphans the ballots already cast (those units can vote again,
and their first ballots stay counted), so change it only when no poll is open.

`app.env` must set `VISITOR_PASS_TOKEN_KEY` (ADR 0043; the app refuses to
boot without it, and says so): the key that derives each visitor pass's
token, so the host's app can show a pass's code, QR and link again. Generate
it with `openssl rand -base64 48`. The rule: **different per environment, and
never equal to `IDENTIFIER_PEPPER`, `ENTRY_CREDENTIAL_KEY`, `PARCEL_TOKEN_KEY`
or `ENGAGEMENT_REF_SECRET`** (boot refuses an equal value). Changing it hides
the codes of the passes active at the time (their codes keep opening the
gate; the host reissues the link to see one again).

`app.env` must set `GATE_BUNDLE_SIGNING_KEY` (ADR 0057; the app refuses to
boot without it): the 32-byte seed of the Ed25519 key that signs the gate
bundles guard devices download (`openssl rand -base64 32`). Never equal to
another key. To rotate: generate a new seed, raise
`GATE_BUNDLE_SIGNING_KEY_VERSION`, and set `GATE_BUNDLE_PREVIOUS_PUBLIC_KEYS`
to `<old version>:<old public key>` (`GET /api/v1/gate/offline/keys` shows it
before the change) for 24 hours, the longest a bundle lives; then remove it.
No old private key is kept anywhere.

`app.env` must set `ENGAGEMENT_TOKEN_KEYS` (ADR 0057; the app refuses to
boot without it, and says so): `1:<key>`, the key that derives each worker
card's token, so the gate's offline bundle can carry what a guard device needs
to know a card. Generate the key with `openssl rand -base64 48`. The rule:
**different per environment, and never equal to any other key** (boot
refuses). To rotate, append `,2:<new key>` and set
`ENGAGEMENT_TOKEN_KEY_VERSION=2`: new and reissued cards take the new key,
printed ones keep theirs; drop the old version only once no live card was
derived with it (`SELECT count(*) FROM worker_engagements WHERE
token_key_version = 1 AND qr_token_hash IS NOT NULL`, per compound).

Staging stores files on its own MinIO (`minio.env`, the `/jiwar/` nginx
location). `app.env` must set `S3_*` (ADR 0029; the app refuses to boot
without them): `S3_ENDPOINT=http://191.218.163.45` (the public address the
presigned URLs are signed for), `S3_REGION=us-east-1`, `S3_BUCKET=jiwar`,
`S3_FORCE_PATH_STYLE=true` and MinIO credentials.

`deploy.sh` and `nginx.conf` are installed by hand: a change to either is
copied to the server, it does not ship with the image. The dashboards' HTTPS
server blocks, and the public web pages', are not in `nginx.conf` at all.

## Production object storage: Cloudflare R2

Production files live in a private R2 bucket (ADR 0029). The app is
configured through `S3_*` only; there are no `R2_*` variables.

| Variable | Value |
|---|---|
| `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `S3_REGION` | `auto` |
| `S3_BUCKET` | the production bucket, e.g. `jiwar-prod` |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | an R2 API token with **Object Read & Write**, scoped to that bucket only |
| `S3_FORCE_PATH_STYLE` | `true` (R2 accepts both; path-style keeps the bucket out of the host name) |
| `S3_URL_TTL_SECONDS` | `300` |

Provisioning, outside the app:
- **Public access stays off:** no r2.dev subdomain and no custom domain on
  the bucket. Every read is a presigned URL from the API.
- **A token per bucket.** The production token never reaches another
  bucket, and the dev bucket has its own token.
- **CORS**, because apps upload straight to R2 with the presigned PUT:
  allow origins = the web app's origin(s); methods `PUT`, `GET`; headers
  `Content-Type`, `If-None-Match`; no credentials.
- No object lifecycle rule deletes files: the app's sweep owns deletion.

Before switching an environment to R2, run the smoke test against its dev
bucket: point `S3_*` in a local `.env` at it, then
`R2_SMOKE=1 pnpm test:r2-smoke`.

## Operations

```bash
ssh root@191.218.163.45 'sudo -u jiwar-deploy jiwar-community-deploy status'
ssh root@191.218.163.45 'sudo -u jiwar-deploy jiwar-community-deploy rollback'   # app and dashboards, no migrate
ssh root@191.218.163.45 'cd /srv/jiwar-community && docker compose -p jiwar-community logs -f app'
ssh -L 8025:127.0.0.1:8125 root@191.218.163.45   # Mailpit (OTP codes): http://localhost:8025
```

The super admin is created on first start from `SUPERADMIN_*` in `app.env`.
After the first login, remove `SUPERADMIN_PASSWORD` from it.
