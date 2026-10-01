import { AccountsService } from '../../src/core/accounts/accounts.service';
import { GatesService } from '../../src/gate/gates/gates.service';
import { ShiftsService } from '../../src/gate/shifts/shifts.service';
import type { Compound } from './community';
import { communityHelpers } from './community';
import { nationalIdFor, uniqueSuffix } from './fixtures';
import { uniqueEmail, uniquePhone, type HttpHarness } from './http-app';

/** Gates, guards and shifts for the gate suites (ADR 0028). */
export function gateHelpers(h: HttpHarness) {
  const c = communityHelpers(h);

  /** A staff account with the default `guard` role. */
  async function guard(compound: Compound, roleKey?: string) {
    const account = await c.asManager(compound, () =>
      h.moduleRef.get(AccountsService).create({
        type: 'staff',
        fullName: `Guard ${uniqueSuffix()}`,
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(),
        phone: uniquePhone(),
        email: uniqueEmail('guard'),
        roleKey,
      }),
    );
    return { id: account.id };
  }

  function gate(compound: Compound, name = `Gate ${uniqueSuffix()}`) {
    return c.asManager(compound, () =>
      h.moduleRef.get(GatesService).create({ name, kind: 'mixed' }),
    );
  }

  /** The guard's shift at the gate, opened through the service. */
  function startShift(compound: Compound, guardId: string, gateId: string) {
    return c.as(compound, { id: guardId, type: 'staff' }, () =>
      h.moduleRef.get(ShiftsService).start(gateId),
    );
  }

  /** A guard on duty: account, gate, open shift. */
  async function onDuty(compound: Compound) {
    const g = await guard(compound);
    const at = await gate(compound);
    const shift = await startShift(compound, g.id, at.id);
    return {
      guardId: g.id,
      gateId: at.id,
      gateName: at.name,
      shiftId: shift.id,
    };
  }

  return { guard, gate, startShift, onDuty };
}
