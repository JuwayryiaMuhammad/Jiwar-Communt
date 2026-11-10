import {
  vatDeclarationRow,
  withholdingCertificateRow,
} from '../setup/tax-rows';
import type { Side } from './world';

/** Taxes (ADR 0093) as the API suites see them: B's rows. */
export interface M36World {
  /** A withholding certificate of B's. */
  bWithholdingCertificateId: string;
  /** A month of B's declared, long ago. */
  bVatDeclarationId: string;
}

export async function m36World(b: Side, bVendorId: string): Promise<M36World> {
  return {
    bWithholdingCertificateId: await withholdingCertificateRow({
      tenantId: b.tenantId,
      vendorId: bVendorId,
    }),
    bVatDeclarationId: await vatDeclarationRow({
      tenantId: b.tenantId,
      declaredById: b.ids.manager,
      month: '2000-01-01',
    }),
  };
}
