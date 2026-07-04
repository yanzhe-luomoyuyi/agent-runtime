/**
 * The reducer: a pure function `(state, event) => state`.
 *
 * This is the heart of the event-sourcing model. State is *derived*, never
 * stored. To rebuild state after a crash we simply fold every event through
 * this reducer — see `reduce()`. Because it is pure and deterministic, the same
 * log always produces the same state, which is what makes runs safely resumable.
 */

import type { AgentEvent, PhaseState, RunState } from './types.js';

export function emptyState(runId: string): RunState {
  return { runId, status: 'running', phases: {}, stepOutputs: {}, toolResults: {}, modelResults: {} };
}

export function applyEvent(state: RunState, event: AgentEvent): RunState {
  const phases = { ...state.phases };
  const phaseOf = (name: string): PhaseState => phases[name] ?? { status: 'NOT_STARTED', stepsCompleted: [] };

  switch (event.type) {
    case 'RunStarted':
      return { ...state, runId: event.runId, input: event.input, workflow: event.workflow, status: 'running' };

    case 'PhaseStarted':
      phases[event.phase] = { ...phaseOf(event.phase), status: 'IN_PROGRESS' };
      return { ...state, currentPhase: event.phase, currentStep: undefined, phases };

    case 'StepStarted':
      return { ...state, currentPhase: event.phase, currentStep: event.step };

    case 'ToolCallSucceeded':
      return { ...state, toolResults: { ...state.toolResults, [event.callId]: event.result } };

    case 'ModelCalled':
      return { ...state, modelResults: { ...state.modelResults, [event.callId]: event.response } };

    case 'StepCompleted': {
      const phase = phaseOf(event.phase);
      const stepsCompleted = phase.stepsCompleted.includes(event.step)
        ? phase.stepsCompleted
        : [...phase.stepsCompleted, event.step];
      phases[event.phase] = { ...phase, stepsCompleted };
      return { ...state, phases, stepOutputs: { ...state.stepOutputs, [event.stepId]: event.output } };
    }

    case 'PhaseCompleted':
      phases[event.phase] = { ...phaseOf(event.phase), status: 'COMPLETED' };
      return { ...state, phases };

    case 'PhaseSkipped':
      phases[event.phase] = { ...phaseOf(event.phase), status: 'SKIPPED', skipReason: event.reason };
      return { ...state, phases };

    case 'RunCompleted':
      return { ...state, status: 'completed', summary: event.summary };

    case 'RunFailed':
      return { ...state, status: 'failed', error: event.error };

    // Observability-only events carry no state transition:
    // ToolCallRequested, ToolCallFailed, PolicyDenied.
    default:
      return state;
  }
}

/** Fold an ordered event log into the current run state. */
export function reduce(events: AgentEvent[], runId: string, initialState?: RunState): RunState {
  return events.reduce(applyEvent, initialState ?? emptyState(runId));
}
