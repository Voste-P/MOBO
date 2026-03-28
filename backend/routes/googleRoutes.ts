/**
 * Google OAuth Routes
 *
 * Implements the OAuth 2.0 Authorization Code flow so users can
 * authenticate with their Google account and export data to their
 * own Google Sheets / Drive.
 *
 * Flow:
 *  1. Frontend calls GET /api/google/auth → redirect URL returned
 *  2. User signs in with Google in a popup
 *  3. Google redirects to GET /api/google/callback with auth code
 *  4. Backend exchanges code for tokens, stores refresh token on User
 *  5. Callback page sends postMessage to opener and closes popup
 */

import { Router } from 'express';
import * as crypto from 'crypto';
import type { Env } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import { writeAuditLog } from '../services/audit.js';
import { logAccessEvent, logAuthEvent, logChangeEvent, logErrorEvent } from '../config/appLogs.js';
import { prisma, isPrismaAvailable } from '../database/prisma.js';
import { idWhere } from '../utils/idWhere.js';
import { authLog, businessLog } from '../config/logger.js';

// ─── Helpers ───────────────────────────────────────────────────────

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

function isGoogleOAuthConfigured(env: Env): boolean {
  return !!(
    (env as any).GOOGLE_CLIENT_ID &&
    (env as any).GOOGLE_CLIENT_SECRET
  );
}

/**
 * Resolve the Google OAuth redirect URI.
 * Uses the explicit env var if set, otherwise derives it from the incoming request.
 * The derived URI MUST match what is registered in the Google Cloud Console.
 */
function resolveRedirectUri(env: Env, req: import('express').Request): string {
  if ((env as any).GOOGLE_REDIRECT_URI) return (env as any).GOOGLE_REDIRECT_URI;
  // Auto-derive from request origin (works for both local dev and production)
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:8080';
  return `${proto}://${host}/api/google/callback`;
}

// ─── Signed-state helpers (survives server restarts) ───────────
// Instead of in-memory Map, we encode { userId, createdAt, nonce } into the
// OAuth state parameter itself, signed with HMAC-SHA256.  The callback verifies
// the signature — no server-side storage needed.

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

let _oauthSigningKey = '';
function getSigningKey(env: Env): string {
  if (!_oauthSigningKey) {
    _oauthSigningKey = (env as any).JWT_ACCESS_SECRET || 'fallback-oauth-signing-key';
  }
  return _oauthSigningKey;
}

function createSignedState(userId: string, env: Env): string {
  const payload = JSON.stringify({
    uid: userId,
    ts: Date.now(),
    nonce: crypto.randomBytes(12).toString('hex'),
  });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSigningKey(env))
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifySignedState(state: string, env: Env): { userId: string; createdAt: number } | null {
  const dotIdx = state.indexOf('.');
  if (dotIdx < 0) return null;
  const payloadB64 = state.slice(0, dotIdx);
  const sig = state.slice(dotIdx + 1);
  const expectedSig = crypto
    .createHmac('sha256', getSigningKey(env))
    .update(payloadB64)
    .digest('base64url');
  // Constant-time comparison to prevent timing attacks
  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (!payload.uid || !payload.ts) return null;
    if (Date.now() - payload.ts > STATE_TTL_MS) return null;
    return { userId: String(payload.uid), createdAt: payload.ts };
  } catch {
    return null;
  }
}

// ─── Routes ────────────────────────────────────────────────────────

export function googleRoutes(env: Env): Router {
  const router = Router();

  /**
   * GET /api/google/auth
   * Returns the Google OAuth consent URL.
   * Requires authentication (we need userId to store tokens later).
   */
  router.get('/auth', requireAuth(env), (req, res) => {
    if (!isGoogleOAuthConfigured(env)) {
      return res.status(503).json({
        error: {
          code: 'GOOGLE_OAUTH_NOT_CONFIGURED',
          message: 'Google OAuth is not configured on this server.',
        },
      });
    }

    const userId = (req as any).auth?.userId || (req as any).auth?.user?._id;
    if (!userId) {
      return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Could not determine user identity.' } });
    }
    const state = createSignedState(String(userId), env);

    businessLog.info(`[Auth] User ${String(userId)} initiated Google OAuth`, { actorUserId: String(userId), ip: req.ip });
    logAccessEvent('RESOURCE_ACCESS', {
      userId: String(userId),
      ip: req.ip,
      resource: 'GoogleOAuth',
      requestId: String((res as any).locals?.requestId || ''),
      metadata: { action: 'GOOGLE_OAUTH_INITIATED' },
    });

    // Use 'consent' prompt to ensure we get a refresh_token.
    // Google only returns refresh_token on the very first consent or when prompt=consent.
    // We also include 'include_granted_scopes' for incremental authorization.
    const redirectUri = resolveRedirectUri(env, req);
    const params = new URLSearchParams({
      client_id: (env as any).GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });

    return res.json({ url: `${GOOGLE_AUTH_URL}?${params.toString()}` });
  });

  /**
   * GET /api/google/callback
   * Handles the OAuth callback from Google. Exchanges the authorization
   * code for tokens and stores the refresh token on the user's record.
   * Returns an HTML page that sends a postMessage to the opener window
   * and closes itself.
   */
  router.get('/callback', async (req, res) => {
    const { code, state, error } = req.query as Record<string, string>;

    if (error) {
      return res.send(makeCallbackHtml(false, `Google login was denied: ${error}`));
    }

    if (!code || !state) {
      return res.send(makeCallbackHtml(false, 'Missing authorization code or state parameter.'));
    }

    const pending = verifySignedState(state, env);
    if (!pending) {
      return res.send(makeCallbackHtml(false, 'Invalid or expired state. Please try again.'));
    }

    if (!isGoogleOAuthConfigured(env)) {
      return res.send(makeCallbackHtml(false, 'Google OAuth is not configured on this server.'));
    }

    try {
      // Exchange authorization code for tokens
      const redirectUri = resolveRedirectUri(env, req);
      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: (env as any).GOOGLE_CLIENT_ID,
          client_secret: (env as any).GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }).toString(),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        authLog.error('Google token exchange failed', { detail: errText });
        return res.send(makeCallbackHtml(false, 'Failed to exchange authorization code.'));
      }

      const tokenData = (await tokenRes.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        token_type: string;
      };

      if (!tokenData.refresh_token) {
        // This can happen if the user previously authorized and Google doesn't send a new refresh token.
        // We asked for prompt=consent so this should be rare.
        authLog.warn('Google OAuth: no refresh_token returned. The user may need to revoke access and re-authorize.');
      }

      // Get the user's Google email
      let googleEmail: string | null = null;
      try {
        const infoRes = await fetch(GOOGLE_USERINFO_URL, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        if (infoRes.ok) {
          const info = (await infoRes.json()) as { email?: string };
          googleEmail = info.email || null;
        }
      } catch {
        // Non-critical — we can still create sheets without the email
      }

      // Store tokens on the user record
      const update: Record<string, any> = {};
      if (tokenData.refresh_token) {
        update.googleRefreshToken = tokenData.refresh_token;
      }
      if (googleEmail) {
        update.googleEmail = googleEmail;
      }

      if (Object.keys(update).length > 0) {
        if (isPrismaAvailable()) {
          const db = prisma();
          const pgUser = await db.user.findFirst({ where: idWhere(pending.userId), select: { id: true } });
          if (pgUser) {
            await db.user.update({ where: { id: pgUser.id }, data: update });
          }
        }
      }

      // Audit log
      writeAuditLog({
        req,
        action: 'GOOGLE_OAUTH_CONNECTED',
        entityType: 'User',
        entityId: pending.userId,
        metadata: { googleEmail, hasRefreshToken: !!tokenData.refresh_token },
      });

      businessLog.info(`[Auth] User ${pending.userId} connected Google account — email: ${googleEmail || 'unknown'}, hasRefreshToken: ${!!tokenData.refresh_token}`, { actorUserId: pending.userId, googleEmail, hasRefreshToken: !!tokenData.refresh_token, ip: req.ip });
      logAuthEvent('LOGIN_SUCCESS', {
        userId: pending.userId,
        ip: req.ip,
        identifier: googleEmail || pending.userId,
        metadata: { provider: 'google', hasRefreshToken: !!tokenData.refresh_token },
      });

      logAccessEvent('RESOURCE_ACCESS', {
        userId: pending.userId,
        ip: req.ip,
        resource: 'GoogleOAuth',
        requestId: String((res as any).locals?.requestId || ''),
        metadata: { action: 'GOOGLE_OAUTH_CONNECTED', googleEmail },
      });

      logChangeEvent({
        actorUserId: pending.userId,
        entityType: 'User',
        entityId: pending.userId,
        action: 'UPDATE',
        changedFields: Object.keys(update),
        before: { googleConnected: false },
        after: { googleConnected: true, googleEmail },
      });

      return res.send(makeCallbackHtml(true, 'Google account connected successfully!'));
    } catch (err: any) {
      logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'EXTERNAL_SERVICE', severity: 'high', requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'google/callback' } });
      authLog.error('Google OAuth callback error', { error: err });
      return res.send(makeCallbackHtml(false, 'An unexpected error occurred. Please try again.'));
    }
  });

  /**
   * GET /api/google/status
   * Returns whether the current user has a Google account connected.
   */
  router.get('/status', requireAuth(env), async (req, res, next) => {
    try {
      const userId = (req as any).auth?.userId;
      if (!userId) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Could not determine user identity.' } });

      let connected = false;
      let googleEmail: string | null = null;
      if (isPrismaAvailable()) {
        const db = prisma();
        const pgUser = await db.user.findFirst({
          where: idWhere(userId),
          select: { googleRefreshToken: true, googleEmail: true },
        });
        if (pgUser) {
          connected = !!pgUser.googleRefreshToken;
          googleEmail = pgUser.googleEmail || null;
        }
      }
      businessLog.info(`[Auth] User ${String(userId)} checked Google OAuth status — connected: ${connected}`, { actorUserId: String(userId), connected, googleEmail, ip: req.ip });
      logAccessEvent('RESOURCE_ACCESS', {
        userId: String(userId),
        ip: req.ip,
        resource: 'GoogleOAuth',
        requestId: String((res as any).locals?.requestId || ''),
        metadata: { action: 'GOOGLE_STATUS_CHECK', connected, googleEmail },
      });
      return res.json({ connected, googleEmail });
    } catch (err) {
      logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'DATABASE', severity: 'low', userId: (req as any).auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'google/status' } });
      next(err);
    }
  });

  /**
   * POST /api/google/disconnect
   * Removes the user's Google tokens.
   */
  router.post('/disconnect', requireAuth(env), async (req, res, next) => {
    try {
      const userId = (req as any).auth?.userId;
      if (!userId) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Could not determine user identity.' } });

      // Clear Google tokens
      if (isPrismaAvailable()) {
        const db = prisma();
        const pgUser = await db.user.findFirst({ where: idWhere(userId), select: { id: true } });
        if (pgUser) {
          await db.user.update({
            where: { id: pgUser.id },
            data: { googleRefreshToken: null, googleEmail: null },
          });
        }
      }

      businessLog.info(`[Auth] User ${String(userId)} disconnected Google account`, { actorUserId: String(userId), ip: req.ip });
      writeAuditLog({
        req,
        action: 'GOOGLE_OAUTH_DISCONNECTED',
        entityType: 'User',
        entityId: String(userId),
      });

      logChangeEvent({
        actorUserId: String(userId),
        entityType: 'User',
        entityId: String(userId),
        action: 'UPDATE',
        changedFields: ['googleRefreshToken', 'googleEmail'],
        before: { googleConnected: true },
        after: { googleConnected: false },
      });

      logAccessEvent('RESOURCE_ACCESS', {
        userId: String(userId),
        ip: req.ip,
        resource: 'GoogleOAuth',
        requestId: String((res as any).locals?.requestId || ''),
        metadata: { action: 'GOOGLE_OAUTH_DISCONNECTED' },
      });

      return res.json({ ok: true });
    } catch (err) {
      logErrorEvent({ error: err instanceof Error ? err : new Error(String(err)), message: err instanceof Error ? err.message : String(err), category: 'DATABASE', severity: 'medium', userId: (req as any).auth?.userId, requestId: String((res as any).locals?.requestId || ''), metadata: { handler: 'google/disconnect' } });
      next(err);
    }
  });

  return router;
}

// ─── HTML template for OAuth popup callback ────────────────

function makeCallbackHtml(success: boolean, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Google Account</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center;
      height: 100vh; margin: 0; background: #f8f9fa;
    }
    .card {
      background: white; border-radius: 12px; padding: 32px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08); text-align: center;
      max-width: 400px;
    }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h2 { margin: 0 0 8px; color: #1a1a1a; }
    p { color: #666; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${success ? '✅' : '❌'}</div>
    <h2>${success ? 'Connected!' : 'Connection Failed'}</h2>
    <p>${escapeHtml(message)}</p>
    <p style="margin-top: 12px; font-size: 13px; color: #999;">This window will close automatically.</p>
  </div>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage({ type: 'GOOGLE_OAUTH_RESULT', success: ${success} }, window.location.origin);
      }
    } catch(e) {}
    setTimeout(function() { window.close(); }, ${success ? 1500 : 4000});
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
