import { describe, expect, it } from 'vitest';
import type { JSONSchema } from '@agent/contracts';

import { formatErrors, isValid, validate } from '../src/schema/validate.js';

const schema: JSONSchema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    limit: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['query'],
  additionalProperties: false,
};

describe('schema validate', () => {
  it('accepts a valid object', () => {
    expect(isValid({ query: 'x', limit: 3, tags: ['a', 'b'] }, schema)).toBe(true);
  });

  it('flags a missing required field', () => {
    const errors = validate({ limit: 1 }, schema);
    expect(errors.some((e) => e.path === '$.query' && /required/.test(e.message))).toBe(true);
  });

  it('flags a wrong type', () => {
    expect(validate({ query: 5 }, schema).some((e) => e.path === '$.query')).toBe(true);
  });

  it('flags a non-integer number', () => {
    expect(validate({ query: 'x', limit: 1.5 }, schema).some((e) => /integer/.test(e.message))).toBe(true);
  });

  it('rejects additional properties when disallowed', () => {
    expect(validate({ query: 'x', extra: 1 }, schema).some((e) => e.path === '$.extra')).toBe(true);
  });

  it('validates array items positionally', () => {
    expect(validate({ query: 'x', tags: ['ok', 3] }, schema).some((e) => e.path === '$.tags[1]')).toBe(true);
  });

  it('supports enum', () => {
    expect(isValid('b', { enum: ['a', 'b'] })).toBe(true);
    expect(isValid('c', { enum: ['a', 'b'] })).toBe(false);
  });

  it('formats errors readably', () => {
    expect(formatErrors([{ path: '$.q', message: 'is required' }])).toContain('$.q is required');
  });
});
