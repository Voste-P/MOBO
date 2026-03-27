import request from 'supertest';

import { createApp } from '../../app.js';
import { loadEnv } from '../../config/env.js';

describe('health', () => {
  let app: any;

  beforeAll(async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
    });

    app = createApp(env);
  });

  it('GET /api/health returns ok', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
    expect(res.body.database).toMatchObject({ status: 'connected' });
    expect(typeof res.body.timestamp).toBe('string');
    expect(typeof res.headers['x-request-id']).toBe('string');
    expect(String(res.headers['x-request-id'])).toBeTruthy();
  });

  it('echoes X-Request-Id when provided', async () => {
    const res = await request(app).get('/api/health').set('x-request-id', 'test-request-id-123');

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe('test-request-id-123');
  });
});
