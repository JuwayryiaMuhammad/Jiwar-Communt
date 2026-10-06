import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import pinoHttp from 'pino-http';
import { httpLogOptions } from '../../src/core/common/logging/http-log-options';

/**
 * Secrets never reach the logs (ADR 0025): the app's own HTTP log options,
 * as in production, over a real request whose body and response carry
 * secrets and whose headers carry credentials.
 */
describe('API v0 — logs', () => {
  const lines: string[] = [];
  let server: Server;
  let base: string;

  const SECRETS = {
    requestToken: 'invite-token-SECRET-1',
    responseCode: '87654321',
    bearer: 'eyJ-SECRET-BEARER',
    cookie: 'session=SECRET-COOKIE',
    // The app's install id identifies a device (ADR 0036).
    installId: '0192a5f0-1c2b-7d3e-8f40-5ec4e7000001',
  };

  beforeAll(async () => {
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
    server = createServer((req, res) => {
      logger(req, res);
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        req.log.info({ bodyLength: body.length }, 'handled');
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            accessCode: SECRETS.responseCode,
            token: SECRETS.requestToken,
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('logs the request, never a body, a token or a credential', async () => {
    const res = await fetch(`${base}/api/v1/invites/accept/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${SECRETS.bearer}`,
        cookie: SECRETS.cookie,
        'x-jiwar-install-id': SECRETS.installId,
      },
      body: JSON.stringify({ token: SECRETS.requestToken, code: '123456' }),
    });
    await res.text();
    await new Promise((r) => setTimeout(r, 50));
    const log = lines.join('');
    expect(log).toContain('/api/v1/invites/accept/complete'); // it did log
    expect(log).toContain('request completed');
    for (const secret of Object.values(SECRETS))
      expect(log).not.toContain(secret);
    expect(log).not.toContain('123456');
  });
});
