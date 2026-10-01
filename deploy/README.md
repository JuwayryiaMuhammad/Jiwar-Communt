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

`deploy.sh` and `nginx.conf` are installed by hand: a change to either is
copied to the server, it does not ship with the image.

## Operations

```bash
ssh root@191.218.163.45 'sudo -u jiwar-deploy jiwar-community-deploy status'
ssh root@191.218.163.45 'sudo -u jiwar-deploy jiwar-community-deploy rollback'   # app only
ssh root@191.218.163.45 'cd /srv/jiwar-community && docker compose -p jiwar-community logs -f app'
ssh -L 8025:127.0.0.1:8125 root@191.218.163.45   # Mailpit (OTP codes): http://localhost:8025
```

The super admin is created on first start from `SUPERADMIN_*` in `app.env`.
After the first login, remove `SUPERADMIN_PASSWORD` from it.
