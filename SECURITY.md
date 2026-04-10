# Security Policy — MOBO

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| main    | :white_check_mark: |
| develop | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly.

**Do NOT open a public GitHub issue.**

1. Email: **security@mobo.app** (or the repository owner directly)
2. Include: description, steps to reproduce, impact assessment
3. We will acknowledge within **48 hours** and provide a fix timeline within **7 days**

## Security Measures

- All API endpoints require JWT authentication (except public routes)
- Role-based access control (RBAC) with least-privilege enforcement
- Input validation via Zod schemas on every endpoint
- SQL injection prevention via Prisma parameterized queries
- XSS prevention via React's automatic escaping + CSP headers
- CSRF protection via SameSite cookies + origin validation
- Rate limiting on authentication and sensitive endpoints
- Request body size limits (10 MB max)
- Suspicious pattern detection on all request payloads
- Secrets managed via environment variables (never committed)
- Dependencies audited for known vulnerabilities in CI
- All GitHub Actions pinned to full SHA (supply-chain protection)
