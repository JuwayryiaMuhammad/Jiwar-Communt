import { randomBytes } from 'node:crypto';
import { newId } from '../../src/core/common/uuid';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { hashPassword } from '../../src/core/platform/password';
import { PlatformSessionService } from '../../src/core/platform/platform-session.service';
import { sessionOf } from '../api/world';
import type { Compound } from './community';
import { facilitiesHelpers, type Who } from './facilities';
import { uniqueSuffix } from './fixtures';
import type { HttpHarness } from './http-app';

export type { Who } from './facilities';

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
    setUp,
  };
}

export type FinanceSetUp = Awaited<
  ReturnType<ReturnType<typeof financeHelpers>['setUp']>
>;

export type { Compound };
