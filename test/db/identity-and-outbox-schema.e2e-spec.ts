import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { Client } from 'pg';
import { parseEgyptianNationalId } from '../../src/core/common/egyptian-national-id';
import { newId } from '../../src/core/common/uuid';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import {
  createAccountRow,
  createTenant,
  createUnit,
  roleId,
  uniqueSuffix,
} from '../setup/fixtures';
import { required } from '../setup/test-env';

const MIGRATION = join(
  __dirname,
  '../../prisma/migrations/20260930100000_identity_documents_outbox/migration.sql',
);

/**
 * Phase 2.1 schema (ADR 0018, 0019): the birth-date backfill agrees with the
 * code, and every new constraint holds, asserted by name.
 */
describe('Identity documents and outbox schema', () => {
  let h: DbHarness;
  let tenant: string;

  beforeAll(async () => {
    h = await createDbHarness();
    tenant = await createTenant(h, 'Identity schema');
  });

  afterAll(() => h.close());

  /** Runs `fn` in the tenant's transaction; resolves to the error, if any. */
  const inTenant = (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
    h
      .asTenant(tenant, () => h.tenantTx.withTenantTx(fn))
      .then(() => null)
      .catch((e: unknown) => e);

  const violation = (constraint: string) => ({
    message: expect.stringContaining(constraint) as unknown,
  });

  // --------------------------------------------------------------------------
  describe('birth date backfill', () => {
    const samples = [
      '29001010100011', // 1990-01-01
      '30802291234567', // leap day 2008
      '31001018812345', // born abroad (88)
      '29912313512345', // 1999-12-31, South Sinai
      '29002300100011', // 30 February
      '30702290100011', // 29 Feb in a common year
      '29001010000011', // governorate 00
      '29001012000011', // governorate 20
      '19001010100011', // century 1
      '39901010100011', // 2099: in the future
      '2900101010001', // 13 digits
      'A1234567', // a passport number
    ];

    it('the SQL function agrees with the code parser on every sample', async () => {
      const rows = await h.asTenant(tenant, () =>
        h.tenantTx.withTenantTx(
          (tx) =>
            tx.$queryRaw<{ id: string; birth: Date | null }[]>`
            SELECT s AS id, egyptian_national_id_birth_date(s) AS birth
              FROM unnest(${samples}::text[]) AS s`,
        ),
      );
      for (const { id, birth } of rows) {
        const expected = parseEgyptianNationalId(id)?.birthDate ?? null;
        expect([id, birth?.toISOString() ?? null]).toEqual([
          id,
          expected?.toISOString() ?? null,
        ]);
      }
    });

    it("the migration's own backfill fills legacy accounts and invites, and leaves unparsable ones NULL", async () => {
      const good = await createAccountRow(h, tenant);
      const legacy = await createAccountRow(h, tenant);
      const unit = await createUnit(h, tenant);
      const inviteId = newId();
      await inTenant(async (tx) => {
        // Rows as a Phase 2 database had them: no birth date stored.
        await tx.account.update({
          where: { id: good.id },
          data: { idDocumentNumber: '30802291234567', birthDate: null },
        });
        await tx.account.update({
          where: { id: legacy.id },
          data: { idDocumentNumber: 'LEGACY-123', birthDate: null },
        });
        await tx.householdInvite.create({
          data: {
            id: inviteId,
            tenantId: tenant,
            unitId: unit.id,
            invitedById: good.id,
            fullName: 'Old Invite',
            phone: '+201000000123',
            email: `old-${uniqueSuffix()}@example.test`,
            idDocumentNumber: '29912313512345',
            relation: 'parent',
            tokenHash:
              'f'.repeat(48) + uniqueSuffix().padEnd(16, '0').slice(0, 16),
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        });
      });

      // Exactly the DO block the migration ran, as the migrator.
      const sql = readFileSync(MIGRATION, 'utf8');
      const block = /DO \$\$[\s\S]*?END \$\$;/.exec(sql)![0];
      const migrator = new Client({
        connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
      });
      await migrator.connect();
      try {
        await migrator.query(block);
      } finally {
        await migrator.end();
      }

      const [g, l, i] = await h.asTenant(tenant, () =>
        Promise.all([
          h.prisma.tenant.account.findUniqueOrThrow({ where: { id: good.id } }),
          h.prisma.tenant.account.findUniqueOrThrow({
            where: { id: legacy.id },
          }),
          h.prisma.tenant.householdInvite.findUniqueOrThrow({
            where: { id: inviteId },
          }),
        ]),
      );
      expect(g.birthDate?.toISOString()).toBe('2008-02-29T00:00:00.000Z');
      expect(l.birthDate).toBeNull();
      expect(i.birthDate?.toISOString()).toBe('1999-12-31T00:00:00.000Z');
    });
  });

  // --------------------------------------------------------------------------
  describe('constraints', () => {
    it('a national ID is Egyptian; a passport names a country and has a birth date', async () => {
      const residentRole = await roleId(h, tenant, 'resident');
      const account = (data: Partial<Prisma.AccountUncheckedCreateInput>) =>
        inTenant((tx) =>
          tx.account.create({
            data: {
              id: newId(),
              tenantId: tenant,
              type: 'resident',
              roleId: residentRole,
              fullName: 'Doc Holder',
              idDocumentNumber: 'X1234567',
              phone: `+2010${Math.floor(Math.random() * 1e8)
                .toString()
                .padStart(8, '0')}`,
              email: `doc-${uniqueSuffix()}@example.test`,
              ...data,
            },
          }),
        );
      expect(await account({ nationality: 'US' })).toMatchObject(
        violation('accounts_identity_document'),
      );
      expect(
        await account({ idDocumentType: 'passport', nationality: 'US' }),
      ).toMatchObject(violation('accounts_identity_document'));
      expect(
        await account({
          idDocumentType: 'passport',
          nationality: 'us',
          birthDate: new Date('1990-01-01'),
        }),
      ).toMatchObject(violation('accounts_identity_document'));
      expect(
        await account({
          idDocumentType: 'passport',
          nationality: 'US',
          birthDate: new Date('1990-01-01'),
        }),
      ).toBeNull();
    });

    it('a minor carries a full document of either type; an adult member carries none', async () => {
      const owner = await createAccountRow(h, tenant);
      const unit = await createUnit(h, tenant);
      const member = (
        data: Partial<Prisma.HouseholdMemberUncheckedCreateInput>,
      ) =>
        inTenant((tx) =>
          tx.householdMember.create({
            data: {
              id: newId(),
              tenantId: tenant,
              unitId: unit.id,
              relation: 'child',
              birthDate: new Date('2015-01-01'),
              status: 'active',
              addedById: owner.id,
              isMinor: true,
              fullName: 'Kid',
              ...data,
            },
          }),
        );
      expect(
        await member({
          idDocumentNumber: 'P7654321',
          idDocumentType: 'passport',
          nationality: 'SD',
        }),
      ).toBeNull();
      // NULL nationality or type: a CHECK passes on NULL unless every term
      // is a plain boolean.
      expect(
        await member({
          idDocumentNumber: 'P7654321',
          idDocumentType: 'passport',
        }),
      ).toMatchObject(violation('household_members_minor_or_account'));
      expect(
        await member({ idDocumentNumber: 'P7654321', nationality: 'SD' }),
      ).toMatchObject(violation('household_members_minor_or_account'));
      expect(
        await member({
          isMinor: false,
          fullName: null,
          accountId: (await createAccountRow(h, tenant)).id,
          idDocumentNumber: 'P7654321',
          idDocumentType: 'passport',
          nationality: 'SD',
        }),
      ).toMatchObject(violation('household_members_minor_or_account'));
    });

    it('a review flag always has its time; a birth-date attestation has its author', async () => {
      const unit = await createUnit(h, tenant);
      expect(
        await inTenant((tx) =>
          tx.unit.update({
            where: { id: unit.id },
            data: {
              needsHouseholdReview: true,
              householdReviewReason: 'primary_left',
            },
          }),
        ),
      ).toMatchObject(violation('units_household_review_has_time'));
      expect(
        await inTenant((tx) =>
          tx.domesticWorker.create({
            data: {
              id: newId(),
              tenantId: tenant,
              idDocumentHash:
                'e'.repeat(48) + uniqueSuffix().padEnd(16, '0').slice(0, 16),
              idDocumentNumber: 'W1234567',
              idDocumentType: 'passport',
              nationality: 'PH',
              fullName: 'Worker',
              phone: '+639171234567',
              birthDate: new Date('1990-01-01'),
              birthDateVerifiedAt: new Date(),
            },
          }),
        ),
      ).toMatchObject(violation('domestic_workers_birth_date_verification'));
    });

    it('outbox rows: sent means sent_at; only dead rows are stripped, and completely', async () => {
      const row = (data: Partial<Prisma.OutboxMessageUncheckedCreateInput>) =>
        h.globalDb.outboxMessage
          .create({
            data: {
              id: newId(),
              channel: 'email',
              templateKey: 'test',
              locale: 'en',
              recipient: 'r@example.test',
              params: {},
              ...data,
            },
          })
          .then(() => null)
          .catch((e: unknown) => e);
      expect(await row({ status: 'sent' })).toMatchObject(
        violation('outbox_messages_sent_at_matches_status'),
      );
      expect(
        await row({ recipient: null, params: Prisma.DbNull }),
      ).toMatchObject(violation('outbox_messages_stripped_only_when_dead'));
      expect(
        await row({
          status: 'dead',
          recipient: null,
          params: Prisma.DbNull,
          strippedAt: new Date(),
        }),
      ).toBeNull();
      expect(
        await row({ status: 'dead', recipient: null, strippedAt: new Date() }),
      ).toMatchObject(violation('outbox_messages_stripped_only_when_dead'));
    });
  });
});
