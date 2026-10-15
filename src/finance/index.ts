// Public surface of the finance domain (ADR 0015, 0046): a unit's invoices,
// its payments at the office and online, and their receipts. Nothing
// imports finance; it is listed here as every domain is.
export { FinanceModule } from './finance.module';
