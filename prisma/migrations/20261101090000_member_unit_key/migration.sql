-- ============================================================================
-- Children (ADR 0054): a key that names a member, its unit and whether it is
-- a minor, so a child's exit control can point at "this minor of this unit"
-- with one composite foreign key (`ON UPDATE CASCADE`), as member grants
-- already do with (tenant, id, is_minor) (ADR 0021).
-- ============================================================================

CREATE UNIQUE INDEX "household_members_tenant_id_id_unit_id_is_minor_key"
  ON "household_members"("tenant_id", "id", "unit_id", "is_minor");
