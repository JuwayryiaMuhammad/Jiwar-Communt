import createClient, { type Middleware } from 'openapi-fetch';
import type { components, paths } from './schema';
import { ApiError, type ApiErrorBody } from './errors';

export type Schemas = components['schemas'];
export type Schema<K extends keyof Schemas> = Schemas[K];

/**
 * Every browser request goes to the app's own BFF (`/bff/...`), never to the
 * backend: the BFF holds the tokens in httpOnly cookies. The marker header
 * forces a CORS preflight on any cross-site attempt, so another origin cannot
 * drive the BFF with the user's cookies.
 */
export const BFF_HEADER = 'x-jiwar-bff';

export function createApiClient(options: {
  baseUrl: string;
  onUnauthenticated?: () => void;
}) {
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
    credentials: 'same-origin',
    headers: { [BFF_HEADER]: '1' },
  });
  const auth: Middleware = {
    onResponse({ response }) {
      if (response.status === 401) options.onUnauthenticated?.();
      return undefined;
    },
  };
  client.use(auth);
  return client;
}

export type ApiClient = ReturnType<typeof createApiClient>;

/**
 * openapi-fetch resolves to `{ data, error, response }`; screens want a value
 * or a thrown ApiError carrying the backend's error contract (ADR 0013).
 */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call;
  if (!response.ok) {
    throw ApiError.from(response.status, error as ApiErrorBody | undefined);
  }
  return data as T;
}
