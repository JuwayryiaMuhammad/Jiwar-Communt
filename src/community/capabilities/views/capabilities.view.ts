import { ApiProperty } from '@nestjs/swagger';
import { NONE, type Capabilities } from '../capabilities';

/**
 * The `capabilitiesFor` record (ADR 0020) for the caller on one unit. **The
 * apps show or hide features from this**; endpoints enforce the same rules.
 * Every flag is listed, so a new flag appears here and in the contract.
 */
export class CapabilitiesView {
  static from(c: Capabilities): CapabilitiesView {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(NONE))
      out[key] = c[key as keyof Capabilities];
    return out;
  }
}

for (const key of Object.keys(NONE)) {
  ApiProperty(
    key === 'financeCapPerOperation'
      ? {
          type: String,
          nullable: true,
          description: 'Per operation, a decimal string; null = no member cap.',
        }
      : { type: Boolean },
  )(CapabilitiesView.prototype, key);
}
