import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import logger, { securityLog } from '../config/logger.js';
import { logErrorEvent, logSecurityIncident } from '../config/appLogs.js';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;
  public readonly isOperational: boolean;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true; // Distinguishes expected errors from programming bugs
  }
}

// Paths that indicate probing/scanning — log as security incident
const PROBE_PATTERNS = /\.(env|php|asp|cgi|bak|old|sql|config)|wp-admin|phpmyadmin|\/etc\/|\/proc\/|__debug__|actuator|graphql/i;

export function notFoundHandler(req: Request, res: Response): void {
  const isProd = process.env.NODE_ENV === 'production';
  // Only log probing-style 404s as security incidents; legitimate misses are just info
  if (PROBE_PATTERNS.test(req.path)) {
    logSecurityIncident('SUSPICIOUS_PATTERN', { severity: 'medium', userId: (req as any).auth?.userId, ip: req.ip, route: req.path, method: req.method, pattern: 'PROBE_DETECTED', userAgent: req.get('user-agent'), metadata: { query: req.query } });
  } else {
    logger.debug('Route not found', { method: req.method, path: req.path, ip: req.ip });
  }
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: isProd
        ? 'The requested endpoint does not exist.'
        : `Route not found: ${req.method} ${req.path}`,
    },
  });
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // requestId is kept for internal logging only — never exposed in API responses.
  const requestId = String((res.locals as any)?.requestId || res.getHeader?.('x-request-id') || '').trim();

  // Guard: if headers already sent (e.g., during SSE streaming), we can't write another response.
  if (res.headersSent) {
    logger.error('Error after headers sent — cannot respond', {
      requestId,
      method: req.method,
      route: req.originalUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const userId = (req as any).auth?.userId ?? (req as any).auth?.pgUserId;

  if (err instanceof AppError) {
    // Operational errors deserve structured logging at appropriate severity
    const severity = err.statusCode >= 500 ? 'high' : err.statusCode === 403 ? 'medium' : 'low';
    logErrorEvent({
      category: err.statusCode === 401 || err.statusCode === 403 ? 'AUTHORIZATION' : 'BUSINESS_LOGIC',
      severity,
      error: err,
      message: `AppError ${err.statusCode}: ${err.code} — ${err.message}`,
      errorCode: err.code,
      operation: `${req.method} ${req.originalUrl}`,
      requestId,
      userId,
      ip: req.ip,
      method: req.method,
      route: req.originalUrl,
      userFacing: true,
      retryable: err.statusCode === 503 || err.statusCode === 429,
    });
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }

  // Validation errors should never be 500s.
  if (err instanceof z.ZodError) {
    logErrorEvent({
      category: 'VALIDATION',
      severity: 'low',
      error: err,
      message: `Validation failed: ${err.issues.map(i => i.path.join('.')).join(', ')}`,
      errorCode: 'ZOD_VALIDATION',
      operation: `${req.method} ${req.originalUrl}`,
      requestId,
      userId,
      ip: req.ip,
      method: req.method,
      route: req.originalUrl,
      userFacing: true,
      retryable: false,
    });
    const isProd = process.env.NODE_ENV === 'production';
    res.status(400).json({
      error: {
        code: 'BAD_REQUEST',
        message: 'Please check your input and try again.',
        details: isProd
          ? err.issues.map((i) => ({
              // Only expose the leaf field name — never the full path (e.g. "email" not "body.data.email")
              field: i.path.length > 0 ? String(i.path[i.path.length - 1]) : undefined,
              message: i.message,
            }))
          : err.issues,
      },
    });
    return;
  }

  // Malformed JSON from express.json() / body-parser should never be a 500.
  // This commonly appears as a SyntaxError with type='entity.parse.failed'.
  const anyErr = err as any;
  if (
    anyErr &&
    (anyErr.type === 'entity.parse.failed' ||
      (anyErr instanceof SyntaxError && Number((anyErr as any).status) === 400))
  ) {
    logErrorEvent({
      category: 'VALIDATION',
      severity: 'low',
      error: err,
      message: 'Malformed JSON in request body',
      errorCode: 'BAD_JSON',
      operation: `${req.method} ${req.originalUrl}`,
      requestId,
      ip: req.ip,
      method: req.method,
      route: req.originalUrl,
      userFacing: true,
      retryable: false,
    });
    res.status(400).json({
      error: {
        code: 'BAD_JSON',
        message: 'The request body contains invalid JSON. Please check and try again.',
      },
    });
    return;
  }

  // Request body exceeds the configured limit (express.json's `limit` option).
  if (anyErr && anyErr.type === 'entity.too.large') {
    logErrorEvent({
      category: 'VALIDATION',
      severity: 'medium',
      error: err,
      message: `Payload too large: ${req.method} ${req.originalUrl}`,
      errorCode: 'PAYLOAD_TOO_LARGE',
      operation: `${req.method} ${req.originalUrl}`,
      requestId,
      ip: req.ip,
      method: req.method,
      route: req.originalUrl,
      userFacing: true,
      retryable: false,
    });
    res.status(413).json({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'The uploaded data is too large. Please reduce the file size and try again.',
      },
    });
    return;
  }

  // Prisma-specific error handling for clean, actionable API responses.
  if (anyErr?.constructor?.name === 'PrismaClientKnownRequestError' || anyErr?.code?.startsWith?.('P')) {
    const prismaCode = String(anyErr.code || '');
    switch (prismaCode) {
      case 'P2002': // Unique constraint violation
        logErrorEvent({
          category: 'DATABASE',
          severity: 'low',
          error: anyErr,
          message: `Duplicate entry: ${anyErr.meta?.target || 'unknown field'}`,
          errorCode: 'P2002',
          operation: `${req.method} ${req.originalUrl}`,
          requestId,
          userId,
          ip: req.ip,
          method: req.method,
          route: req.originalUrl,
          userFacing: true,
          retryable: false,
        });
        res.status(409).json({
          error: {
            code: 'DUPLICATE_ENTRY',
            message: 'This entry already exists. Please use a different value.',
          },
        });
        return;
      case 'P2025': // Record not found
        logErrorEvent({
          category: 'DATABASE',
          severity: 'low',
          error: anyErr,
          message: `Record not found: ${req.method} ${req.originalUrl}`,
          errorCode: 'P2025',
          operation: `${req.method} ${req.originalUrl}`,
          requestId,
          userId,
          ip: req.ip,
          method: req.method,
          route: req.originalUrl,
          userFacing: true,
          retryable: false,
        });
        res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'The requested item was not found.',
          },
        });
        return;
      case 'P2003': // Foreign key constraint failure
        logErrorEvent({
          category: 'DATABASE',
          severity: 'low',
          error: anyErr,
          message: `Foreign key constraint failed: ${anyErr.meta?.field_name || 'unknown'}`,
          errorCode: 'P2003',
          operation: `${req.method} ${req.originalUrl}`,
          requestId,
          userId,
          ip: req.ip,
          method: req.method,
          route: req.originalUrl,
          userFacing: true,
          retryable: false,
        });
        res.status(400).json({
          error: {
            code: 'INVALID_REFERENCE',
            message: 'The referenced item does not exist.',
          },
        });
        return;
      case 'P2024': // Connection pool timeout
        logger.error('Database connection pool timeout', { requestId, error: anyErr });
        logErrorEvent({
          category: 'DATABASE',
          severity: 'high',
          error: anyErr,
          message: 'Database connection pool timeout',
          errorCode: 'P2024',
          operation: `${req.method} ${req.originalUrl}`,
          requestId,
          ip: req.ip,
          retryable: true,
          userFacing: true,
        });
        res.setHeader('Retry-After', '5');
        res.status(503).json({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'We are experiencing high traffic. Please try again in a moment.',
          },
        });
        return;
      case 'P2010': // Raw query failed
      case 'P2022': // Column does not exist
      case 'P2023': // Inconsistent column data
        logErrorEvent({
          category: 'DATABASE',
          severity: 'critical',
          error: anyErr,
          message: `Database schema error ${prismaCode}`,
          errorCode: prismaCode,
          operation: `${req.method} ${req.originalUrl}`,
          requestId,
          ip: req.ip,
          method: req.method,
          route: req.originalUrl,
          userFacing: true,
          retryable: false,
        });
        res.status(500).json({
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'A database configuration error occurred. Our team has been notified.',
          },
        });
        return;
      default:
        // Log unknown Prisma errors but fall through to generic handler
        logErrorEvent({
          category: 'DATABASE',
          severity: 'high',
          error: anyErr,
          message: `Prisma error ${prismaCode}`,
          errorCode: prismaCode,
          operation: `${req.method} ${req.originalUrl}`,
          requestId,
          ip: req.ip,
          method: req.method,
          route: req.originalUrl,
          userFacing: false,
          retryable: false,
        });
        break;
    }
  }

  // Prisma validation errors (P2000-series client validation)
  if (anyErr?.constructor?.name === 'PrismaClientValidationError') {
    logErrorEvent({
      category: 'DATABASE',
      severity: 'medium',
      error: anyErr,
      message: 'Prisma client validation error',
      errorCode: 'PRISMA_VALIDATION',
      operation: `${req.method} ${req.originalUrl}`,
      requestId,
      userId,
      ip: req.ip,
      method: req.method,
      route: req.originalUrl,
      userFacing: true,
      retryable: false,
    });
    res.status(400).json({
      error: {
        code: 'BAD_REQUEST',
        message: 'The provided data is not valid. Please check and try again.',
      },
    });
    return;
  }

  // JWT-specific errors for better client-side handling
  if (anyErr?.name === 'TokenExpiredError') {
    logErrorEvent({
      category: 'AUTHENTICATION',
      severity: 'low',
      error: anyErr,
      message: 'JWT token expired',
      errorCode: 'TOKEN_EXPIRED',
      operation: `${req.method} ${req.originalUrl}`,
      requestId,
      ip: req.ip,
      method: req.method,
      route: req.originalUrl,
      userFacing: true,
      retryable: false,
    });
    res.status(401).json({
      error: {
        code: 'TOKEN_EXPIRED',
        message: 'Your session has expired. Please log in again.',
      },
    });
    return;
  }
  if (anyErr?.name === 'JsonWebTokenError') {
    securityLog.warn('Invalid JWT token attempt', { requestId, ip: req.ip, error: anyErr.message });
    logSecurityIncident('INVALID_TOKEN', {
      severity: 'medium',
      ip: req.ip,
      route: req.originalUrl,
      method: req.method,
      requestId,
    });
    res.status(401).json({
      error: {
        code: 'INVALID_TOKEN',
        message: 'Your session is invalid. Please log in again.',
      },
    });
    return;
  }

  // Network/connectivity errors — surface as 503 so clients know to retry.
  const networkCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);
  if (anyErr?.code && networkCodes.has(String(anyErr.code))) {
    logger.error('Network error during request', { requestId, code: anyErr.code, error: anyErr.message });
    logErrorEvent({
      category: 'NETWORK',
      severity: 'high',
      error: anyErr,
      message: `Network error: ${anyErr.code}`,
      errorCode: String(anyErr.code),
      operation: `${req.method} ${req.originalUrl}`,
      requestId,
      ip: req.ip,
      retryable: true,
      userFacing: true,
    });
    res.setHeader('Retry-After', '10');
    res.status(503).json({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'A downstream service is temporarily unreachable. Please try again shortly.',
      },
    });
    return;
  }

  // Catch-all: unhandled / unexpected errors — always log at critical severity
  logErrorEvent({
    category: 'SYSTEM',
    severity: 'critical',
    error: err instanceof Error ? err : new Error(String(err)),
    message: `Unhandled error: ${err instanceof Error ? err.message : String(err)}`,
    errorCode: (err as any)?.code || 'UNHANDLED',
    operation: `${req.method} ${req.originalUrl}`,
    requestId,
    userId,
    ip: req.ip,
    method: req.method,
    route: req.originalUrl,
    userFacing: true,
    retryable: false,
  });

  const isProd = process.env.NODE_ENV === 'production';
  const message = isProd
    ? 'Something went wrong. Please try again later.'
    : (err instanceof Error ? err.message : String(err)) || 'Something went wrong. Please try again later.';
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message,
    },
  });
}
