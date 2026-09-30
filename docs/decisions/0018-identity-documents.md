# 0018 — Identity documents

**Status:** Accepted · Phase 2.1 (supersedes the national-ID-only rule of Phase 2)

## Context
Phase 2 made an Egyptian national ID mandatory, because age drives the household and worker rules. That shut out foreign owners, tenants and domestic workers, who hold passports. A passport carries no birth date that the system can derive, so age has to come from somewhere else.

## Decisions
- **Every identity document has a type:** `national_id` or `passport`. This applies on `accounts`, `household_invites`, `household_members` (minors only) and `domestic_workers`:
  - `id_document_type`;
  - `id_document_number` (renamed from `national_id`; the data was kept);
  - `nationality` (ISO 3166-1 alpha-2);
  - a stored `birth_date`.
- **The birth date is stored, never derived at read time.** Every age check uses the stored date through `ageOn(birthDate, date)`:
  - minor or adult in the household;
  - adult at invitation;
  - delegate eligibility;
  - worker age.

  A row with no date (legacy only) fails those checks, the same way as before.
- **Validation** (`core/common/identity-document.ts`):
  - **National ID:** the Egyptian parser (century, a real date, governorate). The birth date comes from the ID, and one sent by the client is ignored. Nationality is `EG`.
  - **Passport:**
    - the number is normalized (trimmed, uppercase, no spaces) and must be 5–20 characters `[A-Z0-9]`;
    - nationality must be a valid ISO code, checked against a hardcoded list of all 249 codes rather than a phone library's country list, plus `XK` (Kosovo): not an official ISO code, but the one in common use for Kosovo, whose passports are real;
    - the birth date is required: a real date, not in the future, age ≤ 120.
  - **Error codes:** `INVALID_NATIONAL_ID`, `INVALID_PASSPORT_NUMBER`, `INVALID_NATIONALITY`, `BIRTH_DATE_REQUIRED` and `INVALID_BIRTH_DATE`, as field codes.
- **CHECKs** hold the shapes:
  - a national ID has nationality `EG`;
  - a passport names a two-letter country, and on accounts and invites has a birth date;
  - a minor carries a complete document, and an adult member carries none (it lives on their account).
- **Backfill:** birth dates were filled from existing national IDs, compound by compound, by `egyptian_national_id_birth_date()`. That SQL copy of the parser is tested against the code. IDs that did not parse stay `NULL`.
- **Passport workers:**
  - **Registering:** someone under 18 on the entered date is refused with `WORKER_UNDERAGE`, with no override. The worker's stored date (possibly corrected) also counts, so re-registering doesn't get around it.
  - **Approval:** the manager must attest the birth date against the passport (`birthDateConfirmed`), once per worker, and may correct it at the same time. This is recorded in `birth_date_verified_by/at` and audited as `worker.birth_date_attested`. A national-ID worker needs no attestation.
  - **Correction later** (`correctBirthDate`): it clears the attestation, so the next approval needs a new one, and is audited as `worker.birth_date_corrected`.
  - **A corrected date under 18:**
    - the engagement under review is rejected;
    - every other active engagement is suspended by management, each with a notice and an audit entry (`reason: underage`);
    - these changes commit, and then the call returns `WORKER_UNDERAGE`;
    - resuming is refused while the worker is under 18.
  - **Dedup:** a national ID keeps its formula, `HMAC("worker-national-id:<id>")`. A passport uses `HMAC("passport:<nationality>:<number>")`, because the same number may exist in two countries.
- **Audit:** `idDocumentNumber`, `nationality` and `birthDate` are sensitive, and appear only as `{ changed: true }`.
- **Phones:** foreign numbers work with `+`. The accounts DTO now validates phones with the services' own `normalizePhone`. class-validator's `@IsPhoneNumber('EG')` also required the number to be Egyptian, and so refused every foreign phone.
  Login (`/auth/otp/request`, `/auth/otp/verify`) takes an email or a phone as `identifier` and parses it with the same `normalizePhone` (`parseIdentifier`). The services' own inputs (invites, workers, contact changes) use it too, so there is one phone rule in the codebase. A resident created with a `+44` number logs in with it (e2e).

## Limits
- The check digit of a national ID is not validated; its algorithm isn't published.
- Codes outside ISO 3166-1 are not accepted as nationalities, except `XK` (Kosovo).
