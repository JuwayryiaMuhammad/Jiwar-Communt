import { FieldExceptionsService } from '../../src/gate/exceptions/field-exceptions.service';
import { ServiceVehiclesService } from '../../src/gate/service-vehicles/service-vehicles.service';
import type { communityHelpers } from '../setup/community';
import type { HttpHarness } from '../setup/http-app';
import type { Side } from './world';

/** B's records of the gate's completion (ADR 0056): foreign ids for the matrix. */
export interface GateCompletionWorld {
  /** A visitor's field exception B's guard raised at B's gate. */
  bFieldExceptionId: string;
  /** A tanker B's guard let in at B's gate. */
  bServiceVehicleId: string;
}

export async function gateCompletionWorld(
  h: HttpHarness,
  helpers: ReturnType<typeof communityHelpers>,
  b: Side,
): Promise<GateCompletionWorld> {
  const exception = await helpers.as(
    b,
    { id: b.ids.guard, type: 'staff' },
    () =>
      h.moduleRef.get(FieldExceptionsService).raise({
        kind: 'visitor_without_pass',
        reasonCode: 'resident_unreachable',
        unitCode: b.homeUnitCode,
      }),
  );
  const visit = await helpers.as(b, { id: b.ids.guard, type: 'staff' }, () =>
    h.moduleRef.get(ServiceVehiclesService).enter({
      plate: 'WRLD 5521',
      kind: 'tanker',
      company: 'World Water',
    }),
  );
  return { bFieldExceptionId: exception.id, bServiceVehicleId: visit.id };
}
