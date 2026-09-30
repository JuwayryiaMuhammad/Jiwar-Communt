import { randomUUID } from 'node:crypto';
import type { Options } from 'pino-http';

/**
 * pino-http options for the app (and the test that proves them). Request
 * and response BODIES are never serialized, so a secret shown once (an
 * access code, an invite or link token, session tokens) never reaches a
 * log: they travel only in bodies. Credentials in headers are redacted.
 */
export function httpLogOptions(opts: { level: string; env: string }): Options {
  return {
    level: opts.level,
    genReqId: (req, res) => {
      const incoming = req.headers['x-request-id'];
      const id =
        typeof incoming === 'string' && incoming.length <= 128
          ? incoming
          : randomUUID();
      res.setHeader('x-request-id', id);
      return id;
    },
    redact: ['req.headers.authorization', 'req.headers.cookie'],
    autoLogging: opts.env !== 'test',
    transport:
      opts.env === 'development'
        ? { target: 'pino-pretty', options: { singleLine: true } }
        : undefined,
  };
}
