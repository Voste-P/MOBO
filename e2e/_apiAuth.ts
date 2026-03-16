import type { APIRequestContext } from '@playwright/test';

export interface E2EUser {
  id: string;
  roles: string[];
  mobile?: string;
  username?: string;
  wallet?: { balancePaise: number };
  [key: string]: unknown;
}

export async function loginAndGetAccessToken(request: APIRequestContext, args: {
  mobile?: string;
  username?: string;
  password: string;
}): Promise<{ accessToken: string; user: E2EUser }>
{
  const deadline = Date.now() + 15_000;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    const res = await request.post('/api/auth/login', {
      data: args.username
        ? { username: args.username, password: args.password }
        : { mobile: String(args.mobile || ''), password: args.password },
    });

    const contentType = String(res.headers()?.['content-type'] || '');
    const isJson = contentType.toLowerCase().includes('application/json');
    const payload = isJson ? await res.json().catch(() => null) : null;

    if (!res.ok()) {
      const msg = payload?.error?.message || payload?.message || `Login failed: ${res.status()}`;
      lastError = new Error(String(msg));
    } else {
      const accessToken = payload?.tokens?.accessToken;
      if (typeof accessToken === 'string' && accessToken) {
        return { accessToken, user: payload?.user as E2EUser };
      }

      // During portal startup, a 200 HTML response can slip through if the proxy isn't ready yet.
      if (!isJson) {
        const text = await res.text().catch(() => '');
        lastError = new Error(
          `Login returned non-JSON response (status=${res.status()}, content-type=${contentType}). ` +
            `Body: ${text.slice(0, 300)}`
        );
      } else {
        lastError = new Error('Login response missing accessToken');
      }
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  throw lastError instanceof Error ? lastError : new Error('Login failed: timeout waiting for auth readiness');
}
