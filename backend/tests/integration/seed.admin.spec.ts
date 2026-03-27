import request from 'supertest';

import { createApp } from '../../app.js';
import { loadEnv } from '../../config/env.js';
import { seedAdminOnly } from '../../seeds/admin.js';

describe('admin seeding', () => {
  it('seeds the admin user and allows username/password login', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
    });

    const RUN = Date.now().toString().slice(-6);

    await seedAdminOnly({
      username: `admin_test_${RUN}`,
      password: 'chetan789',
      mobile: `90${RUN}00`,
      name: 'Test Admin',
      forceUsername: true,
      forcePassword: true,
    });

    const app = createApp(env);

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: `admin_test_${RUN}`, password: 'chetan789' });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body).toHaveProperty('user');
    expect(loginRes.body.user).toHaveProperty('role');
    // UI mapper may normalize roles; ensure admin is present.
    expect(String(loginRes.body.user.role)).toBe('admin');
    expect(loginRes.body).toHaveProperty('tokens');
    expect(typeof loginRes.body.tokens?.accessToken).toBe('string');
  });
});
