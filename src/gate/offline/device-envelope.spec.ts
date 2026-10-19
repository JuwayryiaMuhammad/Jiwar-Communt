import { generateKeyPairSync, sign } from 'node:crypto';
import {
  decodePayload,
  devicePublicKey,
  enrolMessage,
  envelopeMessage,
  ENVELOPE_PAYLOAD_MAX,
  signatureDigest,
  signedBy,
} from './device-envelope';

/**
 * Computed independently (Python's `cryptography`), with RFC 8032's first
 * test key: ADR 0057 and the apps' notes repeat them for the device's tests.
 */
const VECTOR = {
  seed: 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A',
  publicKey: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
  tenantId: '01a102b6-6253-74a0-92b1-96e7c9d52601',
  deviceId: '01a102b6-6253-74a0-92b1-9d0f6c2e4a11',
  enrolSignature:
    'r66MZZLmCrrpbGNDfUfh28yT4k-kXFtws__Rrm5mlTaUZNj3JRAGlncqQHar5fcPiii1fFyP_QewN4xLB7Y8AQ',
  payload:
    'eyJwdXJwb3NlIjoiaGVhcnRiZWF0IiwidGVuYW50SWQiOiIwMWExMDJiNi02MjUzLTc0YTAtOTJiMS05NmU3YzlkNTI2MDEiLCJkZXZpY2VJZCI6IjAxYTEwMmI2LTYyNTMtNzRhMC05MmIxLTlkMGY2YzJlNGExMSIsInNlbnRBdCI6IjIwMjYtMTEtMDZUMDk6MDA6MDAuMDAwWiIsInBlbmRpbmdDb3VudCI6MH0',
  envelopeSignature:
    '_p5YsEOLsEmn5m9NqKgGlcfi6LkvMcmYwXxWvtxB_i8MJf5yZ-twWDgF-y012Z7tR2xv5gmbsKRoYhtawF7oCw',
  envelopeDigest:
    '4ceb428902bac27ea7cb1fe1c1c8eead4bb373c56e689e42277b0e783d837086',
};

describe('the device key and what it signs (ADR 0057)', () => {
  it('verifies the enrolment vector', () => {
    expect(
      signedBy(
        VECTOR.publicKey,
        enrolMessage(VECTOR.tenantId, VECTOR.deviceId, VECTOR.publicKey),
        VECTOR.enrolSignature,
      ),
    ).toBe(true);
  });

  it('verifies the envelope vector, and keeps its digest', () => {
    expect(
      signedBy(
        VECTOR.publicKey,
        envelopeMessage(VECTOR.payload),
        VECTOR.envelopeSignature,
      ),
    ).toBe(true);
    expect(signatureDigest(VECTOR.envelopeSignature)).toBe(
      VECTOR.envelopeDigest,
    );
    expect(decodePayload(VECTOR.payload)).toEqual({
      purpose: 'heartbeat',
      tenantId: VECTOR.tenantId,
      deviceId: VECTOR.deviceId,
      sentAt: '2026-11-06T09:00:00.000Z',
      pendingCount: 0,
    });
  });

  it('a signature for one purpose is nothing in the other', () => {
    // The enrolment's signature over the envelope's label, and back.
    expect(
      signedBy(
        VECTOR.publicKey,
        envelopeMessage(VECTOR.payload),
        VECTOR.enrolSignature,
      ),
    ).toBe(false);
    expect(
      signedBy(
        VECTOR.publicKey,
        enrolMessage(VECTOR.tenantId, VECTOR.deviceId, VECTOR.publicKey),
        VECTOR.envelopeSignature,
      ),
    ).toBe(false);
  });

  it('another compound, another device, another key: not valid', () => {
    const other = '01a102b6-6253-74a0-92b1-96e7c9d52602';
    expect(
      signedBy(
        VECTOR.publicKey,
        enrolMessage(other, VECTOR.deviceId, VECTOR.publicKey),
        VECTOR.enrolSignature,
      ),
    ).toBe(false);
    const { publicKey } = generateKeyPairSync('ed25519');
    const x = publicKey.export({ format: 'jwk' }).x!;
    expect(
      signedBy(x, envelopeMessage(VECTOR.payload), VECTOR.envelopeSignature),
    ).toBe(false);
  });

  it('a payload changed by one character is not what was signed', () => {
    const changed = VECTOR.payload.slice(0, -1) + 'A';
    expect(
      signedBy(
        VECTOR.publicKey,
        envelopeMessage(changed),
        VECTOR.envelopeSignature,
      ),
    ).toBe(false);
  });

  it('malformed keys and signatures are simply not valid', () => {
    const msg = envelopeMessage(VECTOR.payload);
    expect(devicePublicKey('short')).toBeNull();
    expect(devicePublicKey('=' + VECTOR.publicKey.slice(1))).toBeNull();
    expect(signedBy('nope', msg, VECTOR.envelopeSignature)).toBe(false);
    expect(signedBy(VECTOR.publicKey, msg, 'nope')).toBe(false);
    expect(
      signedBy(VECTOR.publicKey, msg, VECTOR.envelopeSignature + '='),
    ).toBe(false);
    // A low-order point is refused by the library, never thrown.
    expect(signedBy('A'.repeat(43), msg, VECTOR.envelopeSignature)).toBe(false);
  });

  it('round-trips a key the device makes', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const x = publicKey.export({ format: 'jwk' }).x!;
    const payload = Buffer.from('{"purpose":"bundle"}').toString('base64url');
    const sig = sign(
      null,
      Buffer.from(envelopeMessage(payload)),
      privateKey,
    ).toString('base64url');
    expect(signedBy(x, envelopeMessage(payload), sig)).toBe(true);
  });

  it('decodes only a JSON object within the bound', () => {
    const b = (s: string) => Buffer.from(s).toString('base64url');
    expect(decodePayload(b('[1]'))).toBeNull();
    expect(decodePayload(b('null'))).toBeNull();
    expect(decodePayload(b('{"a":'))).toBeNull();
    expect(decodePayload('not base64url!')).toBeNull();
    expect(decodePayload('A'.repeat(ENVELOPE_PAYLOAD_MAX + 1))).toBeNull();
    expect(decodePayload(b('{"a":1}'))).toEqual({ a: 1 });
  });
});
