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
        'partner',
        'partner_subcategory',
        'partner_request',
        'partner_complaint',
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
        'gate_service_request',
        'invoice_batch',
        'credit_note',
        'billing_plan',
        'payment',
        'payment_session',
        'instalment_plan',
        'invoice_dispute',
        'refund',
        'unit_permit',
        'material_entry',
        // ADR 0050.
        'guard_roster_template',
        'guard_roster_slot',
        'guard_handover_item',
        'guard_handover',
        'guard_task',
        'guard_shift_swap',
        'guard_instruction',
        'found_item',
        'board_term',
        'board_member',
        'governance_poll',
        'governance_contest',
        'governance_election',
        'governance_candidate',
        'board_publication',
        // ADR 0052.
        'patrol_checkpoint',
        'patrol_route',
        'patrol_run',
        'patrol_note',
        // ADR 0053.
        'gate_lockdown',
        'blocklist_entry',
        'incident',
        'incident_note',
        'unit_violation',
        'unit_violation_payment',
        // ADR 0054.
        'child_control',
        'child_escort',
        'child_pickup',
        // ADR 0055.
        'governance_approval',
        'board_motion',
        'budget',
        'budget_line',
        'expense',
        'expense_authorization',
        'governance_board_appeal',
        // ADR 0056.
        'gate_field_exception',
        'service_vehicle_visit',
        'incident_signature',
        // ADR 0057.
        'gate_device',
        'gate_offline_flag',
        'gate_offline_batch',
        // ADR 0058
        'ticket_quote',
        // ADR 0059
        'decision_appeal',
        'governance_representative',
        'governance_representative_matter',
        'governance_agenda_proposal',
        'governance_objection',
        'unit_document',
      ]).toContain(def.target);
    }
  });
});
