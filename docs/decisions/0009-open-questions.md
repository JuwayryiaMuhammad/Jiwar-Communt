# 0009 — Open questions

**Status:** Open

1. **Self-registration.** The journey documents describe resident self-registration with manager approval; ADR 0003 drops it for now. Confirm with the product owner that this is agreed.
2. **Compound handover between tenants.** If developers or management companies become customers, a compound may move from one tenant to another (e.g. developer → operator after handover). Needs an explicit, audited transfer design.
3. **A second OTP channel.** Field staff may not read email on shift; WhatsApp or SMS behind `OtpChannel`.
4. **Shorter sessions for sensitive roles** (accountant, system admin, control room re-verify every session in the journey documents). The per-type policy exists; the values and account types do not yet.
5. **Existing data on schema changes.** Phase 1a made `accounts.role_id` mandatory; Phase 0 data was never deployed, so the dev database was reset instead of backfilled. Once real data exists, such changes need backfill migrations.
6. **Audit log follow-ups** (ADR 0014): hash chaining, blocking owner DDL on audit tables, retention and actor anonymization, read-access logging, export.
