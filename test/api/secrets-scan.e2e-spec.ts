import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { Logger } from '@nestjs/common';
import pinoHttp from 'pino-http';
import { LoginAlerts } from '../../src/core/auth/login-alerts';
import { httpLogOptions } from '../../src/core/common/logging/http-log-options';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { PrismaService } from '../../src/core/database/prisma.service';
import { communityHelpers, type Compound } from '../setup/community';
import { buildExports } from '../setup/exports';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { waitForMessage, waitForOtp } from '../setup/mailpit';
import { drainOutbox } from '../setup/outbox';

const NOT_ME_LINK = /\/a\/not-me#([0-9a-f-]{36}\.[0-9a-f]{64})/;
const EXPORT_LINK = /\/a\/export#([0-9a-f-]{36}\.[0-9a-f]{64})/;

/**
 * Secrets in emails (ADR 0036): the "not me" token of an unusual-login
 * alert and the download token of an assisted export reach the person's
 * mailbox and nothing else. Both are taken from the emails actually sent
 * (Mailpit), then looked for in every outbox row, the audit trail, the
 * security events, notifications, idempotency rows, the token table itself
 * and everything the app logged — while the emails were rendered and sent
 * and the links were used.
 */
describe('Secrets scan — email action tokens', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let c: Compound;
  const logged: string[] = [];

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
    c = await x.compound('Secrets Court');
    // Everything the app writes to a logger or to the console from here on.
    for (const level of ['log', 'error', 'warn', 'debug', 'verbose'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          logged.push(JSON.stringify(args));
        });
      jest.spyOn(Logger, level).mockImplementation((...args: unknown[]) => {
        logged.push(JSON.stringify(args));
      });
    }
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      jest
        .spyOn(stream, 'write')
        .mockImplementation((chunk: string | Uint8Array, ...rest) => {
          logged.push(
            typeof chunk === 'string'
              ? chunk
              : Buffer.from(chunk).toString('utf8'),
          );
          return write(chunk, ...(rest as []));
        });
    }
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await h.close();
  });

  /** Where a token must never be: as text, every row of every store. */
  async function stores(accountId: string): Promise<Record<string, string>> {
    const globalDb = h.moduleRef.get(GlobalDbService);
    const prisma = h.moduleRef.get(PrismaService);
    const tenant = await x.asManager(c, async () => ({
      audit: await prisma.tenant.auditLog.findMany({}),
      notifications: await prisma.tenant.notification.findMany({}),
      idempotency: await prisma.tenant.idempotencyKey.findMany({}),
      exports: await prisma.tenant.dataExport.findMany({}),
    }));
    return {
      outbox: JSON.stringify(await globalDb.outboxMessage.findMany({})),
      securityEvents: JSON.stringify(
        await globalDb.securityEvent.findMany({ where: { accountId } }),
      ),
      actionTokens: JSON.stringify(await globalDb.actionToken.findMany({})),
      audit: JSON.stringify(tenant.audit),
      notifications: JSON.stringify(tenant.notifications),
      idempotency: JSON.stringify(tenant.idempotency),
      exports: JSON.stringify(tenant.exports),
      logs: logged.join('\n'),
    };
  }

  function expectNowhere(where: Record<string, string>, token: string) {
    const mac = token.split('.')[1];
    for (const [store, text] of Object.entries(where)) {
      expect([store, text.includes(mac)]).toEqual([store, false]);
      expect([store, text.includes(token)]).toEqual([store, false]);
    }
  }

  /** The HTTP log, as in production, over a request carrying the token. */
  async function httpLogOf(token: string): Promise<string> {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const logger = pinoHttp(
      httpLogOptions({ level: 'trace', env: 'production' }),
      sink,
    );
    const server: Server = createServer((req, res) => {
      logger(req, res);
      req.resume();
      req.on('end', () => res.end('{}'));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    await (
      await fetch(`http://127.0.0.1:${port}${API}/public/not-me`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
    ).text();
    await new Promise((r) => setTimeout(r, 50));
    await new Promise<void>((r) => server.close(() => r()));
    return lines.join('');
  }

  it('the "not me" token of an unusual-login alert', async () => {
    const unit = await x.unit(c);
    await x.resident(c, [unit.id]);
    const p = await x.resident(c, [unit.id], 'tenant');
    const alerts = h.moduleRef.get(LoginAlerts);
    const who = { accountId: p.id, tenantId: c.tenantId };
    await alerts.recordLogin(who, { userAgent: 'Secrets/1.0 (Linux)' });
    const since = new Date();
    await alerts.recordLogin(who, {
      userAgent: 'Jiwar/1.0 (Android)',
      installId: '0192a5f0-1c2b-7d3e-8f40-5ec4e7000002',
    });
    await drainOutbox(h);
    const mail = await waitForMessage(p.email, since);
    const token = NOT_ME_LINK.exec(mail.Text)![1];

    await h.http().post(`${API}/public/not-me`).send({ token }).expect(204);
    expectNowhere(
      { ...(await stores(p.id)), httpLog: await httpLogOf(token) },
      token,
    );
  });

  it('the download token of an assisted export, and its code', async () => {
    const unit = await x.unit(c);
    await x.resident(c, [unit.id]);
    const p = await x.resident(c, [unit.id], 'tenant');
    const managerToken = await h.tokenFor({
      sub: c.managerId,
      tid: c.tenantId,
      typ: 'manager',
    });
    await h
      .http()
      .post(`${API}/accounts/${p.id}/data-exports`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ reasonCode: 'in_person' })
      .expect(201);
    const since = new Date();
    await buildExports(h);
    await drainOutbox(h);
    const mail = await waitForMessage(p.email, since);
    const token = EXPORT_LINK.exec(mail.Text)![1];
    const at = new Date();
    await h
      .http()
      .post(`${API}/public/data-exports/code`)
      .send({ token })
      .expect(202);
    const code = await waitForOtp(p.email, at);
    const res = await h
      .http()
      .post(`${API}/public/data-exports/download`)
      .send({ token, code })
      .expect(200);
    const url = (res.body as { url: string }).url;

    const where = { ...(await stores(p.id)), httpLog: await httpLogOf(token) };
    expectNowhere(where, token);
    // Nor the presigned URL it opened, nor the code (stored as an HMAC).
    for (const [store, text] of Object.entries(where)) {
      expect([store, text.includes(url)]).toEqual([store, false]);
      expect([store, text.includes(`"${code}"`)]).toEqual([store, false]);
    }
  });
});
