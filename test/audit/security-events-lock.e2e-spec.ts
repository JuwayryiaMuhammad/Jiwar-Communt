import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { IdentifierHasher } from '../../src/core/auth/identifier';
import { newId } from '../../src/core/common/uuid';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { hashPassword } from '../../src/core/platform/password';
import { PlatformAuthService } from '../../src/core/platform/platform-auth.service';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { auditReaders } from '../setup/audit';
import { uniqueSuffix } from '../setup/fixtures';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { waitForOtp } from '../setup/mailpit';
import { required } from '../setup/test-env';

const TIMEOUT_MS = 500; // SECURITY_EVENT_TIMEOUT_MS default
/** Generous on purpose: what matters is "bounded", not an exact figure. */
const SLACK_MS = 1500;
const PASSWORD = 'lock-test-password-1';

/**
 * A real lock on security_events (not a spy): each write gives up after the
 * database-side timeout, the login goes on, an error is logged, and no
 * connection stays stuck behind the lock (ADR 0014).
 */
describe('security_events locked', () => {
  let h: HttpHarness;
  let locker: Client;
  let observer: Client;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    locker = new Client({
      connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
    });
    observer = new Client({
      connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
    });
    await Promise.all([locker.connect(), observer.connect()]);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await locker.query('ROLLBACK').catch(() => undefined);
    await Promise.all([locker.end(), observer.end()]);
    await h.close();
  });

  async function timed<T>(fn: () => Promise<T>) {
    const started = Date.now();
    const result = await fn();
    return { result, ms: Date.now() - started };
  }

  /** app connections currently waiting on a lock on security_events. */
  async function blockedAppQueries(): Promise<number> {
    const { rows } = await observer.query<{ n: string }>(
      `SELECT count(*) AS n
         FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE NOT l.granted
          AND l.relation = 'security_events'::regclass
          AND a.usename = 'jiwar_app'`,
    );
    return Number(rows[0].n);
  }

  it('logins complete within the timeout, drop their events with an error, and leave the pool healthy', async () => {
    const tenant = await h.createTenant('Locked Court');
    const email = uniqueEmail('locked');
    const resident = await h.createAccount(tenant.id, {
      type: 'resident',
      email,
      phone: uniquePhone(),
    });
    const adminEmail = `admin-${uniqueSuffix()}@jiwar.test`;
    const admin = await h.moduleRef.get(GlobalDbService).platformAdmin.create({
      data: {
        id: newId(),
        email: adminEmail,
        passwordHash: await hashPassword(PASSWORD),
        mustChangePassword: false,
      },
    });
    const identifierHash = h.moduleRef
      .get(IdentifierHasher)
      .hashIdentifier({ type: 'email', value: email });
    const platform = h.moduleRef.get(PlatformAuthService);
    const read = auditReaders(h);

    // Baselines with the table free.
    const freePlatform = await timed(() =>
      platform.login(adminEmail, PASSWORD, '10.8.0.1'),
    );
    const freeVerify = await timed(() =>
      h
        .http()
        .post(`${API}/auth/otp/verify`)
        .send({ identifier: email, code: '000000' })
        .expect(401),
    );

    const errors = jest.spyOn(Logger.prototype, 'error');
    await locker.query('BEGIN');
    await locker.query('LOCK TABLE security_events IN ACCESS EXCLUSIVE MODE');
    try {
      // Platform login: one event (platform.login_succeeded).
      const lockedPlatform = await timed(() =>
        platform.login(adminEmail, PASSWORD, '10.8.0.1'),
      );
      expect(lockedPlatform.result).toHaveProperty('accessToken');
      expect(lockedPlatform.ms).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
      expect(lockedPlatform.ms).toBeLessThan(
        freePlatform.ms + TIMEOUT_MS + SLACK_MS,
      );

      // OTP request: 202 at once, and the code is still emailed
      // (otp.requested is written in the background, bounded the same way).
      const since = new Date();
      const request = await timed(() =>
        h
          .http()
          .post(`${API}/auth/otp/request`)
          .send({ identifier: email })
          .expect(202),
      );
      expect(request.ms).toBeLessThan(SLACK_MS);
      const code = await waitForOtp(email, since);

      // OTP verify with a wrong code: one event (otp.verify_failed).
      const wrong = await timed(() =>
        h
          .http()
          .post(`${API}/auth/otp/verify`)
          .send({
            identifier: email,
            code: code === '000000' ? '111111' : '000000',
          })
          .expect(401),
      );
      expect(wrong.ms).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
      expect(wrong.ms).toBeLessThan(freeVerify.ms + TIMEOUT_MS + SLACK_MS);

      // The right code, then select-account: one event (login.succeeded).
      const verified = await h
        .http()
        .post(`${API}/auth/otp/verify`)
        .send({ identifier: email, code })
        .expect(200);
      const select = await timed(() =>
        h
          .http()
          .post(`${API}/auth/select-account`)
          .send({
            loginTicket: (verified.body as { loginTicket: string }).loginTicket,
            accountId: resident.id,
          })
          .expect(200),
      );
      expect(select.ms).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
      expect(select.ms).toBeLessThan(TIMEOUT_MS + SLACK_MS);

      // One error per dropped event, naming the event and nothing else.
      const dropped = (): string[] =>
        errors.mock.calls
          .map(([message]) => String(message))
          .filter((m) => m.startsWith('security event '));
      const expected = [
        'platform.login_succeeded',
        'otp.requested',
        'otp.verify_failed',
        'login.succeeded',
      ];
      // otp.requested runs in the background: give it its timeout.
      const deadline = Date.now() + TIMEOUT_MS + SLACK_MS;
      while (dropped().length < expected.length && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const messages = dropped();
      expect(messages).toHaveLength(expected.length);
      for (const event of expected) {
        expect(messages.some((m) => m.includes(` ${event} `))).toBe(true);
      }
      for (const m of messages) {
        expect(m).not.toContain(email);
        expect(m).not.toContain(adminEmail);
        expect(m).not.toContain(identifierHash);
      }

      // Every cancelled insert gave its connection back: nothing of the app
      // is still queued behind the lock.
      expect(await blockedAppQueries()).toBe(0);
    } finally {
      await locker.query('ROLLBACK');
    }

    // After the lock: a normal login writes its events normally.
    const since = new Date();
    await platform.login(adminEmail, PASSWORD, '10.8.0.1');
    await h
      .http()
      .post(`${API}/auth/otp/request`)
      .send({ identifier: email })
      .expect(202);
    const code = await waitForOtp(email, since);
    const verified = await h
      .http()
      .post(`${API}/auth/otp/verify`)
      .send({ identifier: email, code })
      .expect(200);
    await h
      .http()
      .post(`${API}/auth/select-account`)
      .send({
        loginTicket: (verified.body as { loginTicket: string }).loginTicket,
        accountId: resident.id,
      })
      .expect(200);

    const after = (rows: { occurredAt: Date }[]) =>
      rows.filter((r) => r.occurredAt >= since);
    expect(
      after(
        await read.security({
          event: 'login.succeeded',
          accountId: resident.id,
        }),
      ),
    ).toHaveLength(1);
    expect(
      after(
        await read.security({
          event: 'platform.login_succeeded',
          platformAdminId: admin.id,
        }),
      ),
    ).toHaveLength(1);
    // otp.requested is written in the background; wait for it.
    const deadline = Date.now() + SLACK_MS;
    const requested = () =>
      read.security({ event: 'otp.requested', identifierHash });
    while ((await requested()).length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // Only the post-lock request: nothing from the locked window was written
    // late, for any of the four events.
    expect(after(await requested())).toHaveLength(1);
    expect(await requested()).toHaveLength(1);
    expect(
      await read.security({ event: 'login.succeeded', accountId: resident.id }),
    ).toHaveLength(1);
    expect(
      await read.security({
        event: 'platform.login_succeeded',
        platformAdminId: admin.id,
      }),
    ).toHaveLength(2); // the unlocked baseline and the post-lock login
    expect(
      await read.security({ event: 'otp.verify_failed', identifierHash }),
    ).toHaveLength(1); // the unlocked baseline only
  });
});
