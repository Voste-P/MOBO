import { describe, it, expect } from 'vitest';
import { AppError } from '../../middleware/errors.js';

describe('AppError', () => {
  it('creates an operational error with all properties', () => {
    const err = new AppError(400, 'VALIDATION_ERROR', 'Name is required', { field: 'name' });
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('Name is required');
    expect(err.details).toEqual({ field: 'name' });
    expect(err.isOperational).toBe(true);
  });

  it('works without details', () => {
    const err = new AppError(404, 'NOT_FOUND', 'Resource not found');
    expect(err.details).toBeUndefined();
  });

  it('has correct prototype chain', () => {
    const err = new AppError(500, 'INTERNAL', 'Something broke');
    expect(err instanceof AppError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(err.stack).toBeDefined();
  });

  it('handles all common HTTP status codes', () => {
    const codes = [
      { status: 400, code: 'BAD_REQUEST' },
      { status: 401, code: 'UNAUTHORIZED' },
      { status: 403, code: 'FORBIDDEN' },
      { status: 404, code: 'NOT_FOUND' },
      { status: 409, code: 'CONFLICT' },
      { status: 413, code: 'PAYLOAD_TOO_LARGE' },
      { status: 429, code: 'TOO_MANY_REQUESTS' },
      { status: 500, code: 'INTERNAL_ERROR' },
      { status: 503, code: 'SERVICE_UNAVAILABLE' },
    ];

    for (const { status, code } of codes) {
      const err = new AppError(status, code, `Error ${status}`);
      expect(err.statusCode).toBe(status);
      expect(err.code).toBe(code);
    }
  });
});
