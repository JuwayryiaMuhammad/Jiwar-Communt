// Public surface of the maintenance domain (ADR 0015). Other domains import
// maintenance only from here; everything else in src/maintenance/ is internal.
export { MaintenanceModule } from './maintenance.module';
// What the daily brief reads of them (ADR 0040).
export {
  ResidentTicketSummary,
  type TicketSummary,
} from './tickets/resident-ticket-summary';
// What the gate reads of a technician's ticket, for their incidents and SOS (ADR 0067).
export { MaintenanceGatePortModule } from './gate-port.module';
export { MaintenanceGatePort, type TechnicianTicket } from './gate-port';
