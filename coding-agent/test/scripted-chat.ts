/**
 * Test-local re-export — the scripted model lives in src/ so both tests and
 * the `eval` CLI scenarios can use it without duplicating the logic.
 */
export {
  ScriptedChatProvider,
  toolTurn,
  finalTurn,
  type ScriptStep,
} from '../src/model/scripted-chat.js';
