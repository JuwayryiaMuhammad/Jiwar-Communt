import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { newId } from '../../src/core/common/uuid';
import {
  enrolMessage,
  envelopeMessage,
} from '../../src/gate/offline/device-envelope';
import type { Compound } from './community';
import { gateCompletionHelpers, type Who } from './gate-completion';
import type { HttpHarness } from './http-app';

export type { Who } from './gate-completion';

/** A guard device as the app holds it: its id and its Ed25519 key pair. */
export interface TestDevice {
  id: string;
  publicKey: string;
  privateKey: KeyObject;
}

/** A device as the management reads it (ADR 0057). */
export interface StaffDeviceBody {
  id: string;
  label: string | null;
  status: 'active' | 'revoked';
  enrolledBy: { id: string; fullName?: string | null; erased?: true };
  enrolledAt: string;
  revokedAt: string | null;
  revokedBy: { id: string; fullName?: string | null; erased?: true } | null;
  revokeReasonCode: string | null;
}

/** A new device: a fresh id and key pair, enrolled nowhere yet. */
export function newDevice(): TestDevice {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    id: newId(),
    publicKey: publicKey.export({ format: 'jwk' }).x!,
    privateKey,
  };
}

/** The device's Ed25519 signature over `message`, base64url. */
export const signAs = (d: TestDevice, message: string): string =>
  sign(null, Buffer.from(message, 'utf8'), d.privateKey).toString('base64url');

/**
 * An envelope as the app sends it: the payload's JSON in base64url, signed
 * with the device's key. `sentAt` and the ids default to what the payload
 * must carry; `over` may break any of them.
 */
export function envelope(
  d: TestDevice,
  tenantId: string,
  purpose: string,
  over: Record<string, unknown> = {},
  signer: TestDevice = d,
): { deviceId: string; payload: string; signature: string } {
  const payload = Buffer.from(
    JSON.stringify({
      purpose,
      tenantId,
      deviceId: d.id,
      sentAt: new Date().toISOString(),
      ...over,
    }),
    'utf8',
  ).toString('base64url');
  return {
    deviceId: d.id,
    payload,
    signature: signAs(signer, envelopeMessage(payload)),
  };
}

/**
 * Helpers for the gate offline's suites (ADR 0057), on top of the gate's
 * completion: devices enrolled over HTTP, revoked by the management, and
 * the envelopes a device signs.
 */
export function offlineHelpers(h: HttpHarness) {
  const g = gateCompletionHelpers(h);

  /** `POST /gate/devices` as `as`, proving `d`'s key (or `over`'s). */
  function enrolRaw(
    as: Who,
    c: Compound,
    d: TestDevice,
    over: Record<string, unknown> = {},
  ) {
    return g.http('post', '/gate/devices', as.token, {
      id: d.id,
      publicKey: d.publicKey,
      proof: signAs(d, enrolMessage(c.tenantId, d.id, d.publicKey)),
      ...over,
    });
  }

  /** A device that must enrol: the device. */
  async function enrol(
    as: Who,
    c: Compound,
    d: TestDevice = newDevice(),
    over: Record<string, unknown> = {},
  ): Promise<TestDevice> {
    const res = await enrolRaw(as, c, d, over);
    if (res.status !== 201)
      throw new Error(`enrol: ${res.status} ${JSON.stringify(res.body)}`);
    return d;
  }

  /** `POST /staff/gate/devices/:id/revoke` as `as`. */
  function revokeRaw(
    as: Who,
    id: string,
    reasonCode = 'lost',
    headers: Record<string, string> = {},
  ) {
    return g.http(
      'post',
      `/staff/gate/devices/${id}/revoke`,
      as.token,
      { reasonCode },
      headers,
    );
  }

  /** `GET /staff/gate/devices/:id` as `as`. */
  const deviceView = async (as: Who, id: string): Promise<StaffDeviceBody> =>
    (await g.http('get', `/staff/gate/devices/${id}`, as.token).expect(200))
      .body as StaffDeviceBody;

  /** The device's row. */
  const deviceRow = (c: Compound, id: string) =>
    g.inTx(c, (tx) => tx.gateDevice.findUnique({ where: { id } }));

  return {
    ...g,
    g,
    enrolRaw,
    enrol,
    revokeRaw,
    deviceView,
    deviceRow,
  };
}
