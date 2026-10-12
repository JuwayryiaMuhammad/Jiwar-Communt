// Public surface of the maintenance domain (ADR 0015). Other domains import
// maintenance only from here; everything else in src/maintenance/ is internal.
export { MaintenanceModule } from './maintenance.module';
// What "all my requests" reads of a resident's tickets (ADR 0039).
export {
  ResidentTicketFeed,
  type FeedCursor,
  type FeedTicket,
} from './tickets/resident-ticket-feed';
