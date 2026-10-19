import { sign } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  bundleSigningKeys,
  type BundleSigningKeys,
} from '../../core/config/bundle-signing-keys';
import type { Env } from '../../core/config/env.schema';

export const BUNDLE_LABEL = 'jiwar:gate-bundle:v1';

/** What a bundle's signature covers: the label, then the body as sent. */
export const bundleMessage = (body: string): string =>
  `${BUNDLE_LABEL}\n${body}`;

/**
 * The server's signature on a gate bundle (ADR 0057): Ed25519 over
 * `jiwar:gate-bundle:v1\n<body>`, where `body` is the base64url of the
 * bundle's JSON — signed as sent, so the device verifies the bytes it got.
 * The key's version is the bundle's key id.
 */
@Injectable()
export class BundleSigner {
  private readonly keys: BundleSigningKeys;

  constructor(config: ConfigService<Env, true>) {
    this.keys = bundleSigningKeys({
      GATE_BUNDLE_SIGNING_KEY: config.get('GATE_BUNDLE_SIGNING_KEY', {
        infer: true,
      }),
      GATE_BUNDLE_SIGNING_KEY_VERSION: config.get(
        'GATE_BUNDLE_SIGNING_KEY_VERSION',
        { infer: true },
      ),
      GATE_BUNDLE_PREVIOUS_PUBLIC_KEYS: config.get(
        'GATE_BUNDLE_PREVIOUS_PUBLIC_KEYS',
        { infer: true },
      ),
    });
  }

  /** The version of the key that signs now. */
  get keyVersion(): number {
    return this.keys.current.version;
  }

  /** The body's signature, base64url. */
  sign(body: string): string {
    return sign(
      null,
      Buffer.from(bundleMessage(body), 'utf8'),
      this.keys.current.privateKey,
    ).toString('base64url');
  }

  /** Every public key a live bundle may carry, the current one marked. */
  publicKeys(): { version: number; publicKey: string; current: boolean }[] {
    return [...this.keys.publicKeys]
      .sort(([a], [b]) => b - a)
      .map(([version, publicKey]) => ({
        version,
        publicKey,
        current: version === this.keys.current.version,
      }));
  }
}
