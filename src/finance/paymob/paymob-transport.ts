import { Injectable } from '@nestjs/common';

/** One HTTP exchange with Paymob, injectable so tests never call Paymob. */
export interface PaymobRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

export interface PaymobResponse {
  status: number;
  /** Parsed JSON, or the raw text when the body is not JSON. */
  body: unknown;
}

/** No answer at all: a timeout or a network failure. */
export class PaymobTransportError extends Error {
  constructor(readonly kind: 'timeout' | 'network') {
    super(`Paymob ${kind}`);
  }
}

export interface PaymobTransport {
  send(request: PaymobRequest): Promise<PaymobResponse>;
}

export const PAYMOB_TRANSPORT = Symbol('PAYMOB_TRANSPORT');

/** The real transport: fetch with a hard timeout. Never logs a header or a body. */
@Injectable()
export class FetchPaymobTransport implements PaymobTransport {
  async send(request: PaymobRequest): Promise<PaymobResponse> {
    let res: Response;
    try {
      res = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body:
          request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(request.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      throw new PaymobTransportError(
        error instanceof Error &&
          (error.name === 'TimeoutError' || error.name === 'AbortError')
          ? 'timeout'
          : 'network',
      );
    }
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON (an HTML error page): kept as text.
    }
    return { status: res.status, body };
  }
}
