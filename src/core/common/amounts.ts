/**
 * A positive EGP amount below a billion, with two decimals at most: a
 * budget, its lines, an expense, a decision's cost (ADR 0055). A unit's
 * invoices and payments keep finance's smaller limit (ADR 0046).
 */
export const LARGE_AMOUNT = /^(?!0+(\.0{1,2})?$)\d{1,9}(\.\d{1,2})?$/;
