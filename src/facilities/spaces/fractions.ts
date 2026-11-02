import type { Prisma } from '@prisma/client';

/**
 * Places on an image (ADR 0084) are fractions of its width and height from
 * its top left corner, kept to five decimals (DECIMAL(6,5)). The service
 * rounds them first and checks the rounded values, so what it checked is
 * what the database stores and its CHECK never sees a box past the edge.
 */
export const SCALE = 100_000;

/** A fraction as a whole number of hundred-thousandths. */
export const units = (v: number): number => Math.round(v * SCALE);

/** Back to a fraction, as stored. */
export const fraction = (u: number): number => u / SCALE;

/** A stored fraction, for a view. */
export const ofDecimal = (d: Prisma.Decimal): number => Number(d);
