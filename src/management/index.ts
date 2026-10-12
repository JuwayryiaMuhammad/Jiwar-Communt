// Public surface of the management domain (ADR 0015, 0039). Other domains
// import management only from here; everything else in src/management/ is
// internal.
export { ManagementModule } from './management.module';
