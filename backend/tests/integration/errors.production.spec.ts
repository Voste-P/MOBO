import express from 'express';
import request from 'supertest';

import { errorHandler } from '../../middleware/errors.js';

describe('error handler production behavior', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('does not leak exception messages in production', async () => {
    process.env.NODE_ENV = 'production';

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const app = express();
    app.get('/boom', () => {
      throw new Error('secret details');
    });
    app.use(errorHandler);

    const res = await request(app).get('/boom').set('x-request-id', 'req-123');

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Something went wrong. Please try again later.',
      },
    });

    errSpy.mockRestore();
  });

  it('includes exception messages in non-production for debugging', async () => {
    process.env.NODE_ENV = 'test';

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const app = express();
    app.get('/boom', () => {
      throw new Error('debug details');
    });
    app.use(errorHandler);

    const res = await request(app).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'debug details',
      },
    });

    errSpy.mockRestore();
  });
});
