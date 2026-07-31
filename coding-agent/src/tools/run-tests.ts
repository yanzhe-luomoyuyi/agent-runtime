/**
 * @deprecated Prefer `./verify.js`. Re-exports kept for older call sites / tests.
 */

export {
  appendVerifyArgs,
  createRunCheckTool,
  createRunTestsTool,
  runVerifyCommand,
  type VerifyOptions,
  type VerifyRecipe,
  type VerifyResult,
} from './verify.js';

/** Legacy options shape accepted by `createRunTestsTool`. */
export type RunTestsOptions = import('./verify.js').VerifyOptions & {
  command?: string[];
};
