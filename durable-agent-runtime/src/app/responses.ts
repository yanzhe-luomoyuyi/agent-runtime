/**
 * Demo model responses — canned, deterministic outputs keyed by the prompt tag
 * that each workflow step emits (e.g. "[analyze.summary] ..."). Part of the demo
 * workload, not the runtime: a real deployment swaps `MockModelProvider` for a
 * live LLM and deletes this file.
 *
 * AGENT_REGRESS=1 degrades the propose output to demonstrate the eval harness
 * catching a regression.
 */

export function cannedResponses(): Record<string, string> {
  return {
    'analyze.summary': 'Login crashes because the session can be null. Keywords: login, auth, session, null.',
    // AGENT_REGRESS simulates a prompt/model change that degrades the output.
    'propose.fix': process.env.AGENT_REGRESS
      ? 'Try turning it off and on again.'
      : 'Guard against a null session in src/auth/login.ts before reading user.token.',
  };
}
