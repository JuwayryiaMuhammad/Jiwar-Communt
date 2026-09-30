import type { FieldError } from '../../src/core/common/errors';
import type { Method } from './request';
import type { Persona, World } from './world';

export type Params = Record<string, string>;

/**
 * One row per endpoint (ADR 0025). The matrix suite derives, for every row:
 * no token → 401, the other token kind → 401, the denied persona → 403, a
 * foreign id → its 404 code, invalid input → 400 with exact `fields`, and a
 * malformed id in the path → 400 INVALID_UUID. `'none'` is always explicit,
 * so a missing case is a decision, never an omission.
 */
export interface Row {
  method: Method;
  /** Without the `/api/v1` prefix, Swagger-style params: `/units/{id}`. */
  path: string;
  auth: 'public' | 'tenant' | 'platform';
  /** A persona the route is for (tenant routes): used for input and foreign-id checks. */
  as?: Persona;
  /**
   * Tenant: a persona whose role lacks the permission (403 FORBIDDEN).
   * Platform: `restricted`, the token issued while a password change is pending
   * (403 PASSWORD_CHANGE_REQUIRED).
   */
  denied: Persona | 'restricted' | 'none';
  /** Ids from compound B (or unknown ids on platform routes), and the 404 code. */
  foreign:
    | {
        params: (w: World) => Params;
        code: string;
        /** A body that passes validation, so the lookup is what fails. */
        body?: (w: World) => object;
        query?: Record<string, string>;
      }
    | 'none';
  /** Input that fails validation, and the exact field errors. */
  invalid:
    | {
        body?: object;
        query?: Record<string, string>;
        fields:
          FieldError[] | { field: string; code: string; params?: object }[];
      }
    | 'none';
  /** The success response carries a secret shown once. */
  noStore?: boolean;
}
