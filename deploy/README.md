# Staging deploy

`http://191.218.163.45` (no domain, plain HTTP). The host also runs other
projects (nginx sites, a host Postgres 16 and Redis, n8n). This stack shares
none of them: its own containers, nothing listening outside 127.0.0.1.

## Flow

1. A push to `main` runs CI (`.github/workflows/ci.yml`).
2. When CI passes, `.github/workflows/deploy.yml` builds the image and pushes
   `ghcr.io/juwayryiamuhammad/jiwar-communt:<sha>`. It can also be run by
   hand (Actions → Deploy → Run workflow), on `main` only.
3. It connects as `jiwar-deploy` and runs `deploy <sha>`, the job's token on
   stdin. That key is bound to `/usr/local/bin/jiwar-community-deploy`
   (`deploy/deploy.sh`) with `command=…,restrict`: no shell, no forwarding.
4. The script pulls the image, takes `compose.yml` from it, then runs the
   README's deploy order: `prisma migrate deploy` as `jiwar_migrator`,
   `access:sync`, the bucket, and only then the app, waiting for its health
   check. If the new app is not healthy, the previous image goes back up.
   Migrations are not undone.

## Server layout

| Path | Contents |
|---|---|
| `/srv/jiwar-community/app.env` | App environment and secrets (root:jiwar-deploy 640) |
| `/srv/jiwar-community/migrator.env` | `MIGRATOR_DATABASE_URL`, seen only by the `migrate` service |
| `/srv/jiwar-community/db.env`, `minio.env` | Postgres superuser and role passwords; MinIO root |
| `/srv/jiwar-community/init.sql` | Copy of `docker/postgres/init.sql` (first start of an empty volume only) |
| `/srv/jiwar-community/current`, `previous` | Deployed SHAs |
| `/etc/nginx/sites-available/jiwar-community` | `deploy/nginx.conf`: default server on port 80, `/jiwar/` to MinIO |

`app.env` must set `PUBLIC_APP_URL` (ADR 0030): visitor links are built from
it and the app refuses to boot without it. The image runs with
`NODE_ENV=production`, so it must be `https://`, the web app's address (a
placeholder until the web app exists; this API host itself is plain HTTP).

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

Staging stores files on its own MinIO (`minio.env`, the `/jiwar/` nginx
location). `app.env` must set `S3_*` (ADR 0029; the app refuses to boot
without them): `S3_ENDPOINT=http://191.218.163.45` (the public address the
presigned URLs are signed for), `S3_REGION=us-east-1`, `S3_BUCKET=jiwar`,
`S3_FORCE_PATH_STYLE=true` and MinIO credentials.

`deploy.sh` and `nginx.conf` are installed by hand: a change to either is
copied to the server, it does not ship with the image.

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
ssh root@191.218.163.45 'sudo -u jiwar-deploy jiwar-community-deploy rollback'   # app only
ssh root@191.218.163.45 'cd /srv/jiwar-community && docker compose -p jiwar-community logs -f app'
ssh -L 8025:127.0.0.1:8125 root@191.218.163.45   # Mailpit (OTP codes): http://localhost:8025
```

The super admin is created on first start from `SUPERADMIN_*` in `app.env`.
After the first login, remove `SUPERADMIN_PASSWORD` from it.
