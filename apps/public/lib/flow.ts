import type { FieldError } from './errors.ts';

/**
 * One link page is at most: say what will happen (`intro`), ask for the
 * emailed code (`code`), and finish (`done`). `dead` is a link the API no
 * longer accepts; the page then shows the invalid-link text.
 */
export type Step = 'intro' | 'code' | 'done' | 'dead';

export type FlowState = {
  step: Step;
  /** A request is in flight: nothing else may be sent. */
  busy: boolean;
  /** An API error code to translate, or null. */
  error: string | null;
  fields: FieldError[];
};

export type FlowEvent =
  | { type: 'submit' }
  | { type: 'advanced'; to: Step }
  | { type: 'failed'; code: string; fields?: FieldError[] }
  | { type: 'edit' }
  | { type: 'restart' };

export type FlowRules = {
  /** Codes that mean the link itself is spent, unknown or expired. */
  dead: readonly string[];
  /** Whether a refused form goes back to `intro` to be corrected. */
  form?: boolean;
};

export const initialFlow: FlowState = { step: 'intro', busy: false, error: null, fields: [] };

export function flowReducer(rules: FlowRules) {
  return (state: FlowState, event: FlowEvent): FlowState => {
    switch (event.type) {
      case 'submit':
        // A second press while a request is out changes nothing.
        if (state.busy || state.step === 'done' || state.step === 'dead') return state;
        return { ...state, busy: true, error: null, fields: [] };
      case 'advanced':
        if (!state.busy) return state;
        return { step: event.to, busy: false, error: null, fields: [] };
      case 'failed': {
        if (!state.busy) return state;
        if (rules.dead.includes(event.code)) return { step: 'dead', busy: false, error: null, fields: [] };
        const fields = event.fields ?? [];
        const step = rules.form && event.code === 'VALIDATION_FAILED' ? 'intro' : state.step;
        return { step, busy: false, error: event.code, fields };
      }
      case 'edit':
        if (state.busy || state.step !== 'code') return state;
        return { ...initialFlow };
      case 'restart':
        // A finished page that can be used again (another export download).
        return state.step === 'done' ? { ...initialFlow } : state;
    }
  };
}

/** Whether the page may send a request now. */
export const canSubmit = (state: FlowState) => !state.busy && (state.step === 'intro' || state.step === 'code');

export const RULES = {
  visitorNotMe: { dead: ['VISITOR_PASS_NOT_FOUND'] },
  accountNotMe: { dead: ['ACTION_TOKEN_INVALID'] },
  // A wrong code (STEP_UP_CODE_INVALID) keeps the page: a new one can be sent.
  export: { dead: ['ACTION_TOKEN_INVALID'] },
  // OTP_INVALID covers a wrong code and a dead invite alike; the API does
  // not tell them apart, so neither does the page.
  invite: { dead: [] },
  registration: { dead: [], form: true },
} satisfies Record<string, FlowRules>;
