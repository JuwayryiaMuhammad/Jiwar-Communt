import type { Response } from 'supertest';
import { call } from './request';
import type { World } from './world';

/**
 * A real call for each no-store route of ADR 0067's technician safety, as
 * A's technician on a ticket of A's owner given to them: an SOS raised and
 * asked to be called off, and an incident reported.
 */
export function technicianSafetyCalls(
  world: () => World,
): Record<string, () => Promise<Response>> {
  const as = (
    who: 'owner' | 'manager' | 'technician',
    method: 'GET' | 'POST',
    path: string,
    body?: object,
  ) => call(world(), method, path, { token: world().a.tokens[who], body });
  /** A new ticket of A's home, in the technician's hands. */
  const ticket = async (): Promise<string> => {
    const categories = (await as('manager', 'GET', '/maintenance/categories'))
      .body as { data: { id: string; key: string }[] };
    const opened = await as('owner', 'POST', '/tickets', {
      unitId: world().a.homeUnitId,
      categoryId: categories.data.find((c) => c.key === 'general')!.id,
      description: 'No-store call',
    });
    const id = (opened.body as { id: string }).id;
    await as('manager', 'POST', `/maintenance/tickets/${id}/assign`, {
      technicianId: world().a.ids.technician,
    });
    return id;
  };
  return {
    'POST /technician/tickets/{id}/sos': async () =>
      as('technician', 'POST', `/technician/tickets/${await ticket()}/sos`, {
        type: 'medical',
      }),
    'POST /technician/tickets/{id}/sos/cancel-request': async () => {
      const id = await ticket();
      await as('technician', 'POST', `/technician/tickets/${id}/sos`, {
        type: 'fire',
      });
      return as(
        'technician',
        'POST',
        `/technician/tickets/${id}/sos/cancel-request`,
        {},
      );
    },
    'POST /technician/tickets/{id}/incidents': async () =>
      as(
        'technician',
        'POST',
        `/technician/tickets/${await ticket()}/incidents`,
        {
          type: 'near_miss',
          severity: 'low',
          occurredAt: new Date().toISOString(),
          description: 'A ladder slipped',
        },
      ),
  };
}
