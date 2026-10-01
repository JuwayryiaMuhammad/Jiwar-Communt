# 0029 — Object storage

**Status:** Accepted · Phase 4

## Context
Worker photos, registration documents ("request correction", ADR 0009 and 0024) and identity scans need files. ADR 0017 deferred object storage until then. A files module was ported from an earlier project: it wrote to a public R2 bucket, took a free-form folder from the client, and exposed a generic upload and delete endpoint. Almost every file here is personal data, and every compound is a tenant, so the design had to change.

## Decisions
- **Any S3 API** (`@aws-sdk/client-s3`): AWS, Cloudflare R2 or MinIO, set by `S3_*` (`S3_ENDPOINT` unset = AWS, `S3_FORCE_PATH_STYLE` for MinIO). The settings are required: a misconfigured deploy fails at boot, not at the first upload.
- **A private bucket.** No object has a public URL. Rows keep the object key, never a URL; `FilesService.url(key)` returns a presigned GET valid for `S3_URL_TTL_SECONDS` (300, at most 3600). It refuses a key outside the caller's tenant prefix. That is a programming error (500), since keys come off rows RLS has already scoped.
- **Keys** are `{tenantId}/{folder}/{random uuid}.{ext}`. The extension comes from the detected type. The uploader's file name is returned, never used in the key.
- **Folders are a closed enum, empty today.** A folder is added with the feature that stores files in it.
- **No upload endpoint.** The action that owns the file takes it (multipart) and calls `storeImage` / `storeDocument`, so the upload carries that action's permission and audit entry. Nothing lets a client fill the bucket on its own.
- **Validation before storage:** a size cap (image 5 MB, document 20 MB, on the actual bytes), the declared type against the action's list, then the magic bytes against the declared type (`validateUpload`). Office files and the audio/video containers share signatures within a family, so there the declared type names the member. Failures are `VALIDATION_FAILED` on the upload's field with `FIELD_REQUIRED`, `FILE_TOO_LARGE` (`maxBytes`), `FILE_TYPE_NOT_ALLOWED` (`allowed`) or `FILE_SIGNATURE_MISMATCH` (ADR 0013).
- **Order with the transaction:** validate, put the object, then run the caller's `write` (its transaction) with the stored file. If `write` throws, the object is deleted, so a rolled-back action leaves no file behind. `deleteObject` (a replaced or erased file) is called after the transaction that cleared the key commits. It is best-effort and logs the key.
- **Local and CI:** MinIO in docker-compose (API 9005, console 9006). The official MinIO images are no longer published, so it is the `pgsty/minio` community build, pinned to `RELEASE.2026-08-04T00-00-00Z`. `pnpm storage:init` creates the dev bucket (refused in production). e2e tests always use the local MinIO and `TEST_S3_BUCKET`, emptied on start, like SMTP goes to Mailpit.

## Consequences
- A crash between the put and the commit can still orphan an object. A reconciling sweep (keys with no row) comes with the first feature that has rows to reconcile against.
- Erasure (ADR 0023) must delete an account's objects once features store them. Since the keys carry no account id, it works from the rows.
- A production bucket is provisioned outside the app: encryption, lifecycle, no public access.
