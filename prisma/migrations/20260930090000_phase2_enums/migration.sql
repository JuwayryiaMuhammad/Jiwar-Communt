-- ============================================================================
-- Phase 2 enums (ADR 0016, 0017) — on their own: a value added with
-- ALTER TYPE … ADD VALUE cannot be used in the transaction that adds it.
-- ============================================================================

-- CreateEnum
CREATE TYPE "otp_purpose" AS ENUM ('login', 'invite_accept');


-- CreateEnum
CREATE TYPE "household_relation" AS ENUM ('spouse', 'child', 'parent', 'sibling', 'other');


-- CreateEnum
CREATE TYPE "household_member_status" AS ENUM ('pending_approval', 'active', 'removed');


-- CreateEnum
CREATE TYPE "household_invite_status" AS ENUM ('pending', 'accepted', 'revoked', 'expired');


-- CreateEnum
CREATE TYPE "delegation_scope" AS ENUM ('household', 'workers');


-- CreateEnum
CREATE TYPE "delegation_end_reason" AS ENUM ('revoked', 'expired', 'member_removed', 'primary_changed', 'account_deactivated');


-- CreateEnum
CREATE TYPE "worker_capacity" AS ENUM ('live_in', 'hourly', 'driver', 'nanny', 'temporary');


-- CreateEnum
CREATE TYPE "worker_engagement_status" AS ENUM ('pending_review', 'active', 'suspended', 'ended', 'rejected');


-- CreateEnum
CREATE TYPE "worker_notice_status" AS ENUM ('pending', 'sent');


-- AlterEnum
ALTER TYPE "account_type" ADD VALUE 'family';

