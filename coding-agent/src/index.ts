export { Workspace, WorkspaceEscapeError } from './workspace.js';
export { createFsTools, MUTATING_FS_TOOLS, compileGlob } from './tools/fs-tools.js';
export { applyPatchToWorkspace, applyDiff, parsePatchEnvelope } from './tools/apply-patch.js';
export {
  createRunTestsTool,
  createRunCheckTool,
  appendVerifyArgs,
  runVerifyCommand,
} from './tools/verify.js';
export {
  createOpenAICompatibleChatProvider,
  chatProviderFromEnv,
} from './model/openai-compatible.js';
export { createResilientChatProvider, providerAsChatModel } from './model/resilient-provider.js';
export type { ChatProviderTier, ResilientChatProviderOptions } from './model/resilient-provider.js';
export {
  createCodingRuntime,
  defaultCodingPolicy,
  resolveWorkspaceRoot,
  DEFAULT_WORKSPACE,
  PACKAGE_ROOT,
  loadCodingConfig,
  loadCodingConfigFile,
  CODING_CONFIG_DEFAULTS,
  type CodingRuntimeOptions,
  type CodingConfig,
  type CodingConfigFile,
} from './runtime-factory.js';
export {
  MEMORY_TOOL_NAMES,
  MEMORY_INSTRUCTIONS,
  withMemoryToolsAllowed,
  workspaceMemoryScope,
} from './memory.js';
export {
  CODING_PROMPT_SOFT_CAP,
  resolveCodingMaxPromptTokens,
  resolveModelIdFromEnv,
} from './prompt-budget.js';
export {
  codingScenarios,
  liveCodingScenarios,
  editedFile,
  testsPass,
  chatModelForEval,
  GUARDRAIL_SCENARIO_NAME,
} from './eval/scenarios.js';
export { makeEvalRuntimeBuilder, type EvalRuntimeOptions } from './eval/runtime.js';
export {
  createFixtureWorkspace,
  bugCases,
  GREETER_BUG,
  SUM_BUG,
  type BugCase,
} from './eval/fixtures.js';

