/**
 * Package root paths — kept tiny so config can import without circular deps.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Package root (…/coding-agent), whether running from src/ or dist/. */
export const PACKAGE_ROOT = join(HERE, '..');
