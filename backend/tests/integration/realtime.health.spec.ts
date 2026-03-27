import request from 'supertest';

import { createApp } from '../../app.js';
import { loadEnv } from '../../config/env.js';

describe('realtime health', () => {
  let app: any;

  beforeAll(async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
    });

    app = createApp(env);
  });

  it('GET /api/realtime/health returns ok', async () => {
    const res = await request(app).get('/api/realtime/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });

  it('GET /api/realtime/stream requires auth', async () => {
    const res = await request(app).get('/api/realtime/stream');
    expect(res.status).toBe(401);
  });
});
