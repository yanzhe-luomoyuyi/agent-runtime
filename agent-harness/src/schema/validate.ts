/**
 * A minimal JSON Schema validator — enough to check model-supplied tool
 * arguments against a `ToolSpec.inputSchema` before the harness executes a tool.
 *
 * This is deliberately NOT a full JSON Schema implementation (no $ref, formats,
 * oneOf, etc.). It covers the subset the contracts expose (type / properties /
 * required / items / enum / additionalProperties), which is all a tool input
 * schema needs. Keeping it dependency-free matches the runtime's zero-runtime-dep
 * style and keeps validation deterministic and easy to test.
 *
 * The point (feature A + B): invalid arguments become a structured error the
 * loop feeds back to the model as an observation, so the model can correct
 * itself — instead of throwing and killing the run.
 */

import type { JSONSchema } from '@agent/contracts';

export interface ValidationError {
  /** JSON-path-ish location of the problem, e.g. `$.query`. */
  path: string;
  message: string;
}

/** Validate `value` against `schema`. Returns an empty array when valid. */
export function validate(value: unknown, schema: JSONSchema, path = '$'): ValidationError[] {
  const errors: ValidationError[] = [];
  validateInto(value, schema, path, errors);
  return errors;
}

/** Convenience boolean form. */
export function isValid(value: unknown, schema: JSONSchema): boolean {
  return validate(value, schema).length === 0;
}

/** Render errors as a single human/model-readable line. */
export function formatErrors(errors: ValidationError[]): string {
  return errors.map((e) => `${e.path} ${e.message}`).join('; ');
}

function validateInto(value: unknown, schema: JSONSchema, path: string, errors: ValidationError[]): void {
  if (schema.enum && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    errors.push({ path, message: `must be one of ${JSON.stringify(schema.enum)}` });
  }

  if (!schema.type) return;

  switch (schema.type) {
    case 'object': {
      if (!isPlainObject(value)) {
        errors.push({ path, message: 'must be an object' });
        return;
      }
      const props = schema.properties ?? {};
      for (const req of schema.required ?? []) {
        if (!(req in value)) errors.push({ path: `${path}.${req}`, message: 'is required' });
      }
      for (const [key, sub] of Object.entries(props)) {
        if (key in value) validateInto(value[key], sub, `${path}.${key}`, errors);
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in props)) errors.push({ path: `${path}.${key}`, message: 'is not an allowed property' });
        }
      } else if (isSchema(schema.additionalProperties)) {
        const extra = schema.additionalProperties;
        for (const key of Object.keys(value)) {
          if (!(key in props)) validateInto(value[key], extra, `${path}.${key}`, errors);
        }
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push({ path, message: 'must be an array' });
        return;
      }
      const items = schema.items;
      if (items) value.forEach((item, i) => validateInto(item, items, `${path}[${i}]`, errors));
      break;
    }
    case 'string':
      if (typeof value !== 'string') errors.push({ path, message: 'must be a string' });
      break;
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) errors.push({ path, message: 'must be a number' });
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) errors.push({ path, message: 'must be an integer' });
      break;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push({ path, message: 'must be a boolean' });
      break;
    case 'null':
      if (value !== null) errors.push({ path, message: 'must be null' });
      break;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isSchema(v: unknown): v is JSONSchema {
  return typeof v === 'object' && v !== null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
