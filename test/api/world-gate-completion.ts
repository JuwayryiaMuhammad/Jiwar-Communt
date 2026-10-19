import { FieldExceptionsService } from '../../src/gate/exceptions/field-exceptions.service';
import { ServiceVehiclesService } from '../../src/gate/service-vehicles/service-vehicles.service';
import { newId } from '../../src/core/common/uuid';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { EntriesService } from '../../src/gate/entries/entries.service';
import { photoPurgeAfter } from '../../src/gate/entries/entry-photo-rules';
import { IncidentsService } from '../../src/gate/incidents/incidents.service';
import type { communityHelpers } from '../setup/community';
import type { HttpHarness } from '../setup/http-app';
import type { Side } from './world';

/** B's records of the gate's completion (ADR 0056): foreign ids for the matrix. */
export interface GateCompletionWorld {
  /** A visitor's field exception B's guard raised at B's gate. */
  bFieldExceptionId: string;
  /** A tanker B's guard let in at B's gate. */
  bServiceVehicleId: string;
  /** A visitor B's guard let in on an approved exception, with their photo. */
  bEntryId: string;
  /**
   * A security incident B's manager reported (`bIncidentId` is a worker's
   * card incident: another table).
   */
  bGateIncidentId: string;
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
  // A second exception, approved, its visitor let in with a photo.
  const approved = await helpers.as(b, { id: b.ids.guard, type: 'staff' }, () =>
    h.moduleRef.get(FieldExceptionsService).raise({
      kind: 'visitor_without_pass',
      reasonCode: 'resident_unreachable',
      unitCode: b.homeUnitCode,
    }),
  );
  await helpers.asManager(b, () =>
    h.moduleRef.get(FieldExceptionsService).decide(approved.id, 'approve'),
  );
  const entry = await helpers.as(b, { id: b.ids.guard, type: 'staff' }, () =>
    h.moduleRef.get(EntriesService).record({
      subjectType: 'field_exception',
      subjectId: approved.id,
      direction: 'in',
    }),
  );
  await helpers.asManager(b, () =>
    h.moduleRef.get(TenantTx).withTenantTx(async (tx) => {
      const fileId = newId();
      const at = new Date();
      await tx.storedFile.create({
        data: {
          id: fileId,
          tenantId: b.tenantId,
          purpose: 'visitor_photo',
          contentType: 'image/png',
          sizeBytes: 100,
          status: 'ready',
          uploadExpiresAt: at,
          finalizedAt: at,
          attachedAt: at,
        },
      });
      await tx.gateEntryPhoto.create({
        data: {
          tenantId: b.tenantId,
          entryId: entry.id,
          fileId,
          subjectType: 'field_exception',
          subjectId: approved.id,
          gateId: b.gateId,
          unitId: b.homeUnitId,
          takenById: b.ids.guard,
          enteredAt: entry.occurredAt,
          purgeAfter: photoPurgeAfter(entry.occurredAt),
        },
      });
    }),
  );
  const incident = await helpers.asManager(b, () =>
    h.moduleRef.get(IncidentsService).report(
      {
        type: 'other',
        severity: 'low',
        unitCode: b.homeUnitCode,
        occurredAt: entry.occurredAt,
        description: 'World incident with evidence',
      },
      'staff',
    ),
  );
  return {
    bFieldExceptionId: exception.id,
    bServiceVehicleId: visit.id,
    bEntryId: entry.id,
    bGateIncidentId: incident.incident.id,
  };
}
