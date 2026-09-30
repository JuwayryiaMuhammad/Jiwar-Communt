import type { Response, Test } from 'supertest';
import { API } from '../setup/http-app';
import type { World } from './world';

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';

/** A request with an optional bearer token. */
export function call(
  w: World,
  method: Method,
  path: string,
  opts: { token?: string; body?: object; query?: Record<string, string> } = {},
): Test {
  const agent = w.h.http();
  const url = `${API}${path}`;
  let req: Test =
    method === 'GET'
      ? agent.get(url)
      : method === 'POST'
        ? agent.post(url)
        : method === 'PATCH'
          ? agent.patch(url)
          : agent.put(url);
  if (opts.token) req = req.set('Authorization', `Bearer ${opts.token}`);
  if (opts.query) req = req.query(opts.query);
  if (method !== 'GET') req = req.send(opts.body ?? {});
  return req;
}

/** `/units/{id}` with its params filled in. */
export function fill(path: string, params: Record<string, string>): string {
  return path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined)
      throw new Error(`No value for {${name}} in ${path}`);
    return encodeURIComponent(value);
  });
}

export function paramNames(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

/** The error envelope of a response (ADR 0013). */
export interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  fields?: { field: string; code: string; params?: object }[];
  params?: Record<string, unknown>;
  requestId?: string;
  timestamp?: string;
  path?: string;
}

export function err(res: Response): ErrorBody {
  return res.body as ErrorBody;
}
