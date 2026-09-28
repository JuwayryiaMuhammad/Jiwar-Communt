# 0003 — Account creation

**Status:** Accepted · Phase 0

## Decision
**Accounts are created by an authorized actor inside the tenant. In Phase 0 that actor is the manager.**

- Required fields: full name, national ID, phone, email.
- There is no self-registration in Phase 0. After creating the account, management sends the app link to the person manually.
- Creating an account and its `login_identifiers` rows is one transaction: either the person can log in, or the account does not exist.

## Why the wording is "an authorized actor"
The journey documents already name other creators that will arrive later:
- the primary resident invites family members;
- a buyer is activated by a link after booking or contracting.

These become additional authorized actors without reversing this decision.

## Superseded
The journey documents describe resident self-registration (name + unit + phone → OTP → "pending review" until the manager approves). This decision replaces it for now; see ADR 0009 for the confirmation still needed from the product owner.
