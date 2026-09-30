# 0009 — Open questions

**Status:** Open

1. **Self-registration.** The journey documents describe resident self-registration with manager approval; ADR 0003 drops it for now. Confirm with the product owner that this is agreed.
2. **Compound handover between tenants.** If developers or management companies become customers, a compound may move from one tenant to another (e.g. developer → operator after handover). Needs an explicit, audited transfer design.
3. **A second OTP channel.** Field staff may not read email on shift; WhatsApp or SMS behind `OtpChannel`.
4. **Shorter sessions for sensitive roles** (accountant, system admin, control room re-verify every session in the journey documents). The per-type policy exists; the values and account types do not yet.
5. **Existing data on schema changes.** Phase 1a made `accounts.role_id` mandatory; Phase 0 data was never deployed, so the dev database was reset instead of backfilled. Once real data exists, such changes need backfill migrations.
6. **Audit log follow-ups** (ADR 0014): hash chaining, blocking owner DDL on audit tables, retention and actor anonymization, read-access logging, export.
7. ~~**Residents without an Egyptian national ID.**~~ *Closed in Phase 2.1: passports are supported (ADR 0018).* From Phase 2 every account must carry a valid Egyptian national ID (`core/common/egyptian-national-id.ts`): the birth date drives the adult/minor rules. Foreign owners and tenants (passport holders) cannot be created until an alternative identity document, and a way to know their age, is designed.
8. ~~**Durable notifications.**~~ *Emails closed in Phase 2.1 (outbox, ADR 0019); worker notices will use the same outbox when SMS/WhatsApp exist.* Household and delegation emails are sent after commit, best effort; worker notices are stored but not yet sent. Both want an outbox with retries once SMS/WhatsApp arrive (ADR 0016, 0017).
9. **Screen-dependent details** to confirm with the design:
   - the worker schedule shape (overnight windows are supported since Phase 2.1);
   - whether occupants count toward the household limit (they do not today);
   - which fields of a member or worker each role sees;
   - ~~whether a rejected join request gets the same email as a removal~~ (its own email since Phase 2.1).
10. **The first adult of a unit with no primary.** A unit flagged `primary_left` has no one who can invite until the manager sets a primary; there is no self-service path for that.
11. **Who sees dead outbox messages.** A notice that could not be delivered is kept as evidence (ADR 0019), but nobody is told yet. It belongs with the manager notifications.
