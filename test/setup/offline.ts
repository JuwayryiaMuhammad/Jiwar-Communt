import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { WorkersService } from '../../src/community/workers/workers.service';
import { newId } from '../../src/core/common/uuid';
import {
  enrolMessage,
  envelopeMessage,
} from '../../src/gate/offline/device-envelope';
import type { Compound } from './community';
import { aroundTheClock, dbClock } from './compound-clock';
import { gateCompletionHelpers, type Who } from './gate-completion';
import type { HttpHarness } from './http-app';

export type { Who } from './gate-completion';

/** A guard device as the app holds it: its id and its Ed25519 key pair. */
export interface TestDevice {
  id: string;
  publicKey: string;
  privateKey: KeyObject;
  /** Its next sequence number, as the app counts. */
  seq: number;
}

/** What an upload answers (ADR 0057). */
export interface UploadBody {
  batchId: string;
  receivedAt: string;
  ackedThroughSeq: number;
  results: {
    clientId: string;
    seq: number;
    status: 'recorded' | 'duplicate' | 'rejected';
    reason: string | null;
    flags: string[];
    entryId: string | null;
  }[];
  serverTime: string;
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
  bundleVersion: number;
  lastBundleAt: string | null;
  bundleValidUntil: string | null;
  onShift: boolean;
  lastSeenAt: string | null;
  lastUploadAt: string | null;
  pendingCount: number | null;
  ackedSeq: number;
  maxSeq: number;
  missingActions: number;
  openFlags: number;
  notCarried: { passes: number; workers: number };
}

/** A gate bundle as the device reads it (ADR 0057): the header and sections. */
export interface BundleBody {
  v: 1;
  bundleId: string;
  tenantId: string;
  deviceId: string;
  version: number;
  shiftId: string;
  gateId: string;
  guardId: string;
  issuedAt: string;
  validUntil: string;
  keyVersion: number;
  timezone: string;
  salt: string;
  lockdown: { scope: 'gate' | 'all'; since: string } | null;
  passes: {
    ref: string;
    unitCode: string;
    kind: string;
    partySize: number;
    entriesUsed: number;
    inside: number;
    validFrom: string;
    validUntil: string;
    schedule: unknown;
    code: string;
    qr: string;
    plate: string | null;
  }[];
  workers: {
    ref: string;
    unitCode: string;
    capacity: string;
    validUntil: string | null;
    schedule: unknown;
    inside: number;
    code: string;
    qr: string;
  }[];
  blocklist: { ref: string; kind: 'ban' | 'watch'; plate: string }[];
  residents: string[];
  [section: string]: unknown;
}

/** What `POST /gate/offline/bundles` answers. */
export interface SignedBundle {
  keyVersion: number;
  body: string;
  signature: string;
  serverTime: string;
}

/** The bundle's JSON, from its base64url. */
export const readBundle = (signed: SignedBundle): BundleBody =>
  JSON.parse(
    Buffer.from(signed.body, 'base64url').toString('utf8'),
  ) as BundleBody;

/** A new device: a fresh id and key pair, enrolled nowhere yet. */
export function newDevice(): TestDevice {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    id: newId(),
    publicKey: publicKey.export({ format: 'jwk' }).x!,
    privateKey,
    seq: 1,
  };
}

/**
 * An entry the device recorded offline on a bundle: in on a pass by its
 * code, at the bundle's issue unless `over` says otherwise. Takes the
 * device's next sequence number.
 */
export function entryAction(
  d: TestDevice,
  bundle: { bundleId: string; issuedAt: string },
  subject: { type: string; id: string },
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    clientId: newId(),
    seq: d.seq++,
    deviceTime: bundle.issuedAt,
    bundleId: bundle.bundleId,
    type: 'entry',
    subjectType: subject.type,
    subjectId: subject.id,
    direction: 'in',
    via: 'code',
    ...over,
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
      sentAt: dbClock().toISOString(),
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

  /** As an account of the compound, in a request's context. */
  const as = <T>(
    c: Compound,
    who: { id: string; type: 'resident' | 'staff' | 'manager' },
    fn: () => Promise<T>,
  ): Promise<T> => g.x.x.x.as(c, who, fn);
  const asManager = <T>(c: Compound, fn: () => Promise<T>): Promise<T> =>
    g.x.x.x.asManager(c, fn);

  /**
   * An approved household worker of the unit, open around the clock,
   * registered by its primary: the engagement and its card, once.
   */
  async function workerWithCard(c: Compound, primary: Who, unitId: string) {
    const p = g.x.x.x.person('worker');
    const reg = await as(c, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef.get(WorkersService).register(unitId, {
        fullName: p.fullName,
        idDocumentType: 'national_id',
        idDocumentNumber: p.idDocumentNumber,
        phone: p.phone,
        capacity: 'nanny',
        schedule: aroundTheClock(),
      }),
    );
    const issued = await asManager(c, () =>
      h.moduleRef.get(WorkersService).review(reg.engagementId, 'approve'),
    );
    return {
      engagementId: reg.engagementId,
      fullName: p.fullName,
      code: issued!.accessCode,
      qr: issued!.card.qrPayload,
    };
  }

  /** `POST /gate/offline/bundles` as `as`, signed by `d` (`over` breaks the payload). */
  function bundleRaw(
    as: Who,
    c: Compound,
    d: TestDevice,
    over: Record<string, unknown> = {},
    signer: TestDevice = d,
  ) {
    return g.http(
      'post',
      '/gate/offline/bundles',
      as.token,
      envelope(d, c.tenantId, 'bundle', over, signer),
    );
  }

  /** A bundle that must be issued: the signed answer and its body. */
  async function bundle(as: Who, c: Compound, d: TestDevice) {
    const res = await bundleRaw(as, c, d);
    if (res.status !== 200)
      throw new Error(`bundle: ${res.status} ${JSON.stringify(res.body)}`);
    const signed = res.body as SignedBundle;
    return { signed, body: readBundle(signed) };
  }

  /** `GET /gate/offline/keys` as `as`. */
  const keys = async (as: Who) =>
    (await g.http('get', '/gate/offline/keys', as.token).expect(200)).body as {
      keys: { version: number; publicKey: string; current: boolean }[];
      serverTime: string;
    };

  /** `POST /gate/offline/uploads` as `as`: the batch, signed by `d`. */
  function uploadRaw(
    as: Who,
    c: Compound,
    d: TestDevice,
    actions: Record<string, unknown>[],
    over: Record<string, unknown> = {},
    signer: TestDevice = d,
  ) {
    return g.http(
      'post',
      '/gate/offline/uploads',
      as.token,
      envelope(
        d,
        c.tenantId,
        'upload',
        { batchId: newId(), actions, ...over },
        signer,
      ),
    );
  }

  /** A batch that must be taken: its answer. */
  async function upload(
    as: Who,
    c: Compound,
    d: TestDevice,
    actions: Record<string, unknown>[],
    over: Record<string, unknown> = {},
  ): Promise<UploadBody> {
    const res = await uploadRaw(as, c, d, actions, over);
    if (res.status !== 200)
      throw new Error(`upload: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as UploadBody;
  }

  /** `POST /gate/offline/heartbeat` as `as`, signed by `d`. */
  function heartbeatRaw(
    as: Who,
    c: Compound,
    d: TestDevice,
    pendingCount: unknown = 0,
  ) {
    return g.http(
      'post',
      '/gate/offline/heartbeat',
      as.token,
      envelope(d, c.tenantId, 'heartbeat', { pendingCount }),
    );
  }

  /** The device's flags, oldest first. */
  const flagsOf = (c: Compound, deviceId: string) =>
    g.inTx(c, (tx) =>
      tx.gateOfflineFlag.findMany({
        where: { deviceId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );

  /** A device enrolled by `as` and its first bundle. */
  async function deviceWithBundle(as: Who, c: Compound) {
    const d = await enrol(as, c);
    const { body } = await bundle(as, c, d);
    return { d, b: body };
  }

  /**
   * A visitor pass of the unit by `host`, valid six hours from four minutes
   * ago (the most a pass may start back is five): an action at its bundle's
   * instant, or clamped two minutes before it, finds it valid.
   */
  async function passFull(
    host: Who,
    unitId: string,
    over: Record<string, unknown> = {},
  ): Promise<{ id: string; code: string; qrPayload: string }> {
    const now = dbClock();
    const res = await g.http(
      'post',
      `/units/${unitId}/visitor-passes`,
      host.token,
      {
        kind: 'one_time',
        partySize: 1,
        validFrom: new Date(now.getTime() - 4 * 60_000).toISOString(),
        validUntil: new Date(now.getTime() + 6 * 3_600_000).toISOString(),
        ...over,
      },
    );
    if (res.status !== 201)
      throw new Error(`pass: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; code: string; qrPayload: string };
  }

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
    as,
    asManager,
    workerWithCard,
    bundleRaw,
    bundle,
    keys,
    passFull,
    uploadRaw,
    upload,
    heartbeatRaw,
    flagsOf,
    deviceWithBundle,
  };
}
