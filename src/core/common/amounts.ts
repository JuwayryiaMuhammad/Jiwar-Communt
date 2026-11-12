/**
 * A positive EGP amount below a billion, with two decimals at most: a
 * budget, its lines, an expense, a decision's cost (ADR 0055). A unit's
 * invoices and payments keep finance's smaller limit (ADR 0046).
 */
export const LARGE_AMOUNT = /^(?!0+(\.0{1,2})?$)\d{1,9}(\.\d{1,2})?$/;

/**
 * The compound's currency, ISO 4217. There is one, for every compound: no
 * table or setting keeps it (ADR 0037, 0046), so the finance views, the club,
 * the fines and the wages all name this value. When a compound can choose,
 * this is the one place to read it from.
 */
export const COMPOUND_CURRENCY = 'EGP';
