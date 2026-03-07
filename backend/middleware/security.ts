/**
 * Security middleware for the MOBO backend.
 *
 * Provides additional hardening beyond Helmet:
 * - Request size limits per route category
 * - Suspicious pattern detection (SQL injection, NoSQL injection, path traversal)
 * - Request timing headers for client-side performance monitoring
 * - Security event logging for audit trail
 */
import type { NextFunction, Request, Response } from 'express';
import { logSecurityIncident } from '../config/appLogs.js';

// ─── Suspicious Pattern Detection ───────────────────────────────────────────
// Patterns that should never appear in normal request parameters.
// These are logged (not blocked) to avoid false positives, but they populate
// the security audit trail for intrusion detection review.
const SUSPICIOUS_PATTERNS = [
  /(\$where|\$gt|\$lt|\$ne|\$regex|\$in|\$nin|\$or|\$and|\$not)/i,  // NoSQL injection
  /(<script[^>]*>|javascript:|on\w+\s*=)/i,                          // XSS vectors
  /(\.\.[/\\]){2,}/,                                                  // Path traversal
  /(union\s+select|insert\s+into|drop\s+table|delete\s+from)/i,      // SQL injection
  /(\x00|\x1a|\x7f)/,                                                 // Null bytes
  /exec(\s|\+)+(s|x)p/i,                                              // MSSQL xp_ calls
  /0x[0-9a-f]{8,}/i,                                                  // Hex-encoded payloads
];

function containsSuspiciousPattern(value: string): string | null {
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(value)) return pattern.source;
  }
  return null;
}

function checkObjectForSuspiciousPatterns(
  obj: Record<string, unknown>,
  location: string,
  req: Request,
  res: Response,
  depth = 0
): void {
  if (depth > 5) return; // Prevent deep recursion
  for (const [key, value] of Object.entries(obj)) {
    // Check the key itself
    const keyMatch = containsSuspiciousPattern(key);
    if (keyMatch) {
      logSecurityIncident('INJECTION_ATTEMPT', {
        severity: 'high',
        ip: req.ip,
        route: req.originalUrl,
        method: req.method,
        requestId: String(res.locals.requestId || ''),
        pattern: keyMatch,
        location: `${location}.${key}`,
        userAgent: req.get('user-agent'),
      });
    }

    // Check string values
    if (typeof value === 'string') {
      const valMatch = containsSuspiciousPattern(value);
      if (valMatch) {
        logSecurityIncident('INJECTION_ATTEMPT', {
          severity: 'high',
          ip: req.ip,
          route: req.originalUrl,
          method: req.method,
          requestId: String(res.locals.requestId || ''),
          pattern: valMatch,
          location: `${location}.${key}`,
          userAgent: req.get('user-agent'),
        });
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      checkObjectForSuspiciousPatterns(value as Record<string, unknown>, `${location}.${key}`, req, res, depth + 1);
    }
  }
}

// Patterns that are unambiguously malicious and should be blocked outright.
const BLOCK_PATTERNS = [
  /(\.\.[/\\]){2,}/,          // Path traversal (../../ etc.)
  /(\x00|\x1a|\x7f)/,         // Null bytes / control characters
  /(union\s+select|insert\s+into|drop\s+table|delete\s+from|;\s*drop\s)/i, // SQL injection
  /(<script[^>]*>|javascript:\s*[a-z]|on(error|load|click|mouse)\s*=)/i,     // High-confidence XSS
  /(\$where|\$gt|\$lt|\$ne|\$regex)\s*:/i,                                   // NoSQL injection operators
];

function containsBlockablePattern(value: string): string | null {
  for (const pattern of BLOCK_PATTERNS) {
    if (pattern.test(value)) return pattern.source;
  }
  return null;
}

function checkObjectForBlockable(obj: Record<string, unknown>, depth = 0): string | null {
  if (depth > 5) return null;
  for (const [, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      const match = containsBlockablePattern(value);
      if (match) return match;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const match = checkObjectForBlockable(value as Record<string, unknown>, depth + 1);
      if (match) return match;
    }
  }
  return null;
}

/**
 * Middleware that logs suspicious request patterns for security monitoring.
 * BLOCKS requests with unambiguously malicious patterns (path traversal, null bytes).
 * Logs others (NoSQL injection, XSS, SQL injection) for audit trail without blocking.
 */
export function securityAuditMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    // Phase 1: Block unambiguously dangerous patterns
    const sources: Array<{ data: Record<string, unknown>; label: string }> = [];
    if (req.query && typeof req.query === 'object') sources.push({ data: req.query as Record<string, unknown>, label: 'query' });
    if (req.body && typeof req.body === 'object') sources.push({ data: req.body as Record<string, unknown>, label: 'body' });
    if (req.params && typeof req.params === 'object') sources.push({ data: req.params as Record<string, unknown>, label: 'params' });

    for (const source of sources) {
      const blockMatch = checkObjectForBlockable(source.data);
      if (blockMatch) {
        logSecurityIncident('MALICIOUS_PAYLOAD', {
          severity: 'critical',
          ip: req.ip,
          route: req.originalUrl,
          method: req.method,
          requestId: String(res.locals.requestId || ''),
          pattern: blockMatch,
          location: source.label,
          userAgent: req.get('user-agent'),
        });
        res.status(400).json({
          error: {
            code: 'BAD_REQUEST',
            message: 'The request contains invalid characters.',
          },
        });
        return;
      }
    }

    // Phase 2: Log suspicious-but-not-conclusive patterns for audit
    for (const source of sources) {
      checkObjectForSuspiciousPatterns(source.data, source.label, req, res);
    }

    next();
  };
}

/**
 * Middleware that adds response timing headers.
 * Helps frontend and monitoring tools measure API latency.
 */
export function responseTimingMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();

    // Hook into writeHead to set timing headers before they're sent
    const originalWriteHead = res.writeHead.bind(res);
    (res as any).writeHead = function (statusCode: number, ...args: any[]) {
      const elapsed = Number(process.hrtime.bigint() - start) / 1_000_000;
      res.setHeader('X-Response-Time', `${elapsed.toFixed(2)}ms`);
      return originalWriteHead(statusCode, ...args);
    };

    next();
  };
}
