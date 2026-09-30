-- API v0 (ADR 0025): registration links get an id, so a manager can list
-- them and revoke one without the token (shown once, stored as a hash).
-- The token hash stays the primary key and the lookup of the public path.
ALTER TABLE "registration_links" ADD COLUMN "id" UUID;
UPDATE "registration_links" SET "id" = gen_random_uuid() WHERE "id" IS NULL;
ALTER TABLE "registration_links" ALTER COLUMN "id" SET NOT NULL;
CREATE UNIQUE INDEX "registration_links_id_key" ON "registration_links"("id");
