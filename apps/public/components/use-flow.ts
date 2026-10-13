'use client';

import { useCallback, useReducer, useRef } from 'react';
import type { ApiResult } from '@/lib/client';
import { flowReducer, initialFlow, type FlowRules, type Step } from '@/lib/flow';

/**
 * A page's steps (lib/flow.ts) with its requests: `run` sends one request
 * and moves to `to` when it succeeds (`onOk` first, so the next step renders
 * with what the answer carried). A second call while one is out does
 * nothing, so a double press cannot send twice.
 */
export function useFlow(rules: FlowRules) {
  const [state, dispatch] = useReducer(flowReducer(rules), initialFlow);
  const inFlight = useRef(false);

  const run = useCallback(async <T,>(request: () => Promise<ApiResult<T>>, to: Step, onOk?: (data: T) => void) => {
    if (inFlight.current) return;
    inFlight.current = true;
    dispatch({ type: 'submit' });
    try {
      const result = await request();
      if (result.ok) {
        onOk?.(result.data);
        dispatch({ type: 'advanced', to });
      } else {
        dispatch({ type: 'failed', code: result.code, fields: result.fields });
      }
    } finally {
      inFlight.current = false;
    }
  }, []);

  return { state, run, dispatch };
}
