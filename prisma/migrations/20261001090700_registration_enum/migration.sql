-- Self-registration codes (ADR 0024): a purpose of their own, so a
-- registration code never logs anyone in or accepts an invite.
ALTER TYPE "otp_purpose" ADD VALUE 'registration';
