// Public surface of the management domain (ADR 0015, 0039). Other domains
// import management only from here; everything else in src/management/ is
// internal.
export { ManagementModule } from './management.module';
// What the daily brief reads of a resident's requests (ADR 0040).
export {
  ResidentRequestSummary,
  type RequestSummary,
} from './feed/resident-request-summary';
// What the partners domain opens: a complaint against a partner (ADR 0060).
export { ManagementPartnersPort, type OpenedRequest } from './partners-port';
