import { PushProcessor } from '../../src/core/push/push-processor';
import type {
  PushMessage,
  PushResult,
  PushTransport,
} from '../../src/core/push/push-transport';
import { API, type HttpHarness } from './http-app';

/**
 * The transport of the push suites (ADR 0041): it records what it is asked
 * to send and answers what the test scripted. Nothing leaves the process.
 */
export class FakePushTransport implements PushTransport {
  readonly sent: PushMessage[] = [];
  private script: ((
    message: PushMessage,
  ) => PushResult | Promise<PushResult>)[] = [];
  private always: ((message: PushMessage) => PushResult) | null = null;

  /** The next sends get these answers, in order; then success again. */
  next(...results: PushResult[]): void {
    this.script.push(...results.map((r) => () => r));
  }

  /** The next send runs this (to throw, or to wait). */
  nextRun(fn: (message: PushMessage) => PushResult | Promise<PushResult>) {
    this.script.push(fn);
  }

  /** Every send to this token gets this answer, until `reset`. */
  failToken(token: string, result: PushResult): void {
    const before = this.always;
    this.always = (m) =>
      m.token === token ? result : (before?.(m) ?? { ok: true });
  }

  reset(): void {
    this.sent.length = 0;
    this.script = [];
    this.always = null;
  }

  /** What was sent to one token. */
  to(token: string): PushMessage[] {
    return this.sent.filter((m) => m.token === token);
  }

  async send(message: PushMessage): Promise<PushResult> {
    this.sent.push(message);
    const scripted = this.script.shift();
    if (scripted) return scripted(message);
    return this.always?.(message) ?? { ok: true };
  }
}

/** Sends everything due, now. The poller is off in tests (PUSH_ENABLED). */
export async function drainPush(h: HttpHarness, now?: Date) {
  const processor = h.moduleRef.get(PushProcessor);
  const total = { sent: 0, retried: 0, dead: 0, dropped: 0 };
  for (;;) {
    const run = await processor.processDue(now);
    for (const key of Object.keys(total) as (keyof typeof total)[])
      total[key] += run[key];
    if (run.sent + run.retried + run.dead + run.dropped === 0) return total;
  }
}

export const INSTALL_1 = '0192a5f0-1c2b-7d3e-8f40-0000000000a1';
export const INSTALL_2 = '0192a5f0-1c2b-7d3e-8f40-0000000000a2';

let counter = 0;
/** A token no other test has: long and random-looking, like FCM's. */
export function pushToken(label = 'tok'): string {
  counter += 1;
  return `${label}-${process.pid}-${Date.now()}-${counter}:APA91b${'x'.repeat(40)}`;
}

export function registerPush(
  h: HttpHarness,
  accessToken: string,
  body: { token: string; platform?: 'android' | 'ios' },
  installId: string | null = INSTALL_1,
) {
  let req = h
    .http()
    .post(`${API}/me/push-tokens`)
    .set('Authorization', `Bearer ${accessToken}`);
  if (installId) req = req.set('X-Jiwar-Install-Id', installId);
  return req.send({ platform: 'android', ...body });
}

export function removePush(
  h: HttpHarness,
  accessToken: string,
  installId: string | null = INSTALL_1,
) {
  let req = h
    .http()
    .delete(`${API}/me/push-tokens`)
    .set('Authorization', `Bearer ${accessToken}`);
  if (installId) req = req.set('X-Jiwar-Install-Id', installId);
  return req.send();
}
