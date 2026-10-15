import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { MemberPermissionsService } from '../../src/community/households/member-permissions.service';
import { newId } from '../../src/core/common/uuid';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { hashPassword } from '../../src/core/platform/password';
import { PlatformSessionService } from '../../src/core/platform/platform-session.service';
import { sessionOf } from '../api/world';
import type { Compound } from './community';
import { day, facilitiesHelpers, type Who } from './facilities';
import { uniqueSuffix } from './fixtures';
import type { HttpHarness } from './http-app';
import { required } from './test-env';

export type { Who } from './facilities';

// ============================================================================
// Finance's test time machine (ADR 0046). TEST-ONLY: it rewrites append-only
// rows over a superuser connection with `session_replication_role =
// replica`, which skips the immutability triggers. src/ cannot import it.
// ============================================================================

async function superuser<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({
    connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
  });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL session_replication_role = replica');
    const out = await fn(db);
    await db.query('COMMIT');
    return out;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    await db.end();
  }
}

/** Moves an invoice's issue and due days `days` into the past. */
export function backdateInvoice(invoiceId: string, days: number) {
  return superuser((db) =>
    db.query(
      `UPDATE invoices SET issued_on = issued_on - $2::int, due_on = due_on - $2::int
        WHERE id = $1`,
      [invoiceId, days],
    ),
  );
}

/** Credentials the fake Paymob accepts; never a real account's. */
export function gatewayBody(over: Record<string, unknown> = {}) {
  return {
    mode: 'sandbox',
    secretKey: `egy_sk_test_${randomBytes(12).toString('hex')}`,
    publicKey: `egy_pk_test_${randomBytes(12).toString('hex')}`,
    hmacSecret: `HMAC${randomBytes(16).toString('hex').toUpperCase()}`,
    cardIntegrationId: 4_100_001,
    walletIntegrationId: 4_100_002,
    ...over,
  };
}

/**
 * Helpers for the finance suites (ADR 0046): a compound with units and their
 * people, the manager and the accountant, step-ups, the gateway, and a
 * platform admin.
 */
export function financeHelpers(h: HttpHarness) {
  const f = facilitiesHelpers(h);
  const { x, who, http } = f;
  const globalDb = () => h.moduleRef.get(GlobalDbService);

  /** Opens the token's session for one sensitive action, as a verified code would. */
  async function stepUp(token: string): Promise<void> {
    await globalDb().session.update({
      where: { id: sessionOf(token) },
      data: { stepUpUntil: new Date(Date.now() + 600_000) },
    });
  }

  /** A platform admin with a live session: its token, opened for one action when `stepped`. */
  async function platformAdmin(stepped = false): Promise<Who> {
    const row = await globalDb().platformAdmin.create({
      data: {
        id: newId(),
        email: `admin-${uniqueSuffix()}@jiwar.test`,
        passwordHash: await hashPassword('finance-password-123'),
        mustChangePassword: false,
      },
    });
    const token = (await h.moduleRef.get(PlatformSessionService).start(row.id))
      .accessToken;
    if (stepped) await platformStepUp(token);
    return { id: row.id, token };
  }

  async function platformStepUp(token: string): Promise<void> {
    await globalDb().platformSession.update({
      where: { id: sessionOf(token) },
      data: { stepUpUntil: new Date(Date.now() + 600_000) },
    });
  }

  /**
   * Sets the compound's gateway and turns online payment on, as its manager
   * (two step-ups): the credentials it was given.
   */
  async function configureGateway(
    manager: Who,
    over: Record<string, unknown> = {},
    enable = true,
  ) {
    const body = gatewayBody(over);
    await stepUp(manager.token);
    await http('put', '/staff/finance/gateway', manager.token, body).expect(
      200,
    );
    if (enable) {
      await stepUp(manager.token);
      await http('patch', '/staff/finance/gateway', manager.token, {
        onlineEnabled: true,
      }).expect(200);
    }
    return body;
  }

  /**
   * `POST /staff/invoices` to one unit (1000 EGP, due in 10 days unless
   * said otherwise): the batch and its invoice's ids.
   */
  async function issue(
    staff: Who,
    unitId: string,
    over: Record<string, unknown> = {},
  ): Promise<{ batchId: string; invoiceId: string }> {
    const res = await http('post', '/staff/invoices', staff.token, {
      target: 'unit',
      unitId,
      kind: 'service_charge',
      dueOn: day(10),
      lines: [
        {
          descriptionEn: 'Service charge',
          descriptionAr: 'رسوم الخدمات',
          amount: '1000',
        },
      ],
      ...over,
    }).expect(201);
    const batchId = (res.body as { id: string }).id;
    const list = await http(
      'get',
      `/staff/invoices?batchId=${batchId}`,
      staff.token,
    ).expect(200);
    return {
      batchId,
      invoiceId: (list.body as { data: { id: string }[] }).data[0].id,
    };
  }

  /** The primary gives a member the unit's money, with a cap per operation. */
  function grantFinance(
    c: Compound,
    primary: Who,
    memberId: string,
    capPerOperation = '5000',
  ) {
    return x.as(c, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef
        .get(MemberPermissionsService)
        .grant(memberId, 'finance', { capPerOperation }),
    );
  }

  /** A compound, its manager and accountant, a home in building A and its owner. */
  async function setUp(name = 'Finance Court') {
    const c = await x.compound(name);
    const home = await f.unit(c, 'A');
    return {
      c,
      home,
      manager: await who(c, c.managerId, 'manager'),
      accountant: await f.accountant(c),
      owner: await f.owner(c, home.id),
    };
  }

  return {
    ...f,
    stepUp,
    platformAdmin,
    platformStepUp,
    configureGateway,
    issue,
    grantFinance,
    setUp,
  };
}

export type FinanceSetUp = Awaited<
  ReturnType<ReturnType<typeof financeHelpers>['setUp']>
>;

export type { Compound };
