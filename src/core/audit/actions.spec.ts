import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIT_ACTIONS, SECURITY_EVENTS } from './actions';

/**
 * Every catalog entry must be emitted somewhere in src/ (ADR 0014): a
 * catalog action nobody records is a gap in the trail, or dead weight.
 */
describe('audit catalog', () => {
  const root = join(__dirname, '..', '..'); // src/

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
    });
  }

  const code = sources(root)
    .filter((f) => !f.endsWith(join('audit', 'actions.ts')))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

  it.each([...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS])(
    '%s is emitted in src/',
    (key) => {
      expect(code).toContain(`'${key}'`);
    },
  );

  it('keys follow <subject>.<verb>', () => {
    for (const key of [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS]) {
      expect(key).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it('each action targets a known kind of thing', () => {
    for (const def of Object.values(AUDIT_ACTIONS)) {
      expect([
        'account',
        'role',
        'occupancy',
        'unit',
        'tenant',
        'platform_admin',
        'household_invite',
        'household_member',
        'household_delegation',
        'domestic_worker',
        'worker_engagement',
        'household_deferred_action',
        'resident_registration',
        'account_deletion_request',
        'gate',
        'guard_shift',
        'visitor_pass',
        'gate_approval_request',
        'standing_instruction',
        'file',
        'entry_credential',
        'ticket_category',
        'preventive_service',
        'ticket',
        'specialty',
        'parcel',
        'data_export',
        'management_request_topic',
        'management_request',
        'management_appointment',
        'suggestion_topic',
        'announcement',
        'community_event',
        'poll',
        'suggestion',
        'neighbour_complaint_category',
        'neighbour_complaint',
        'neighbour_post',
        'neighbour_claim',
        'neighbour_conversation',
        'neighbour_report',
        'neighbour_welcome',
        'facility',
        'booking',
        'facility_closure',
        'booking_suspension',
        'club_plan',
        'club_membership',
        'club_payment',
        'vehicle',
        'parking_slot',
        'visitor_parking_area',
        'visitor_parking_booking',
        'vehicle_fine',
        'vehicle_fine_payment',
        'parking_report',
        'place',
        'emergency',
        'invoice_batch',
        'credit_note',
        'billing_plan',
        'payment',
        'payment_session',
      ]).toContain(def.target);
    }
  });
});
