-- Performance composite indexes for high-traffic query patterns

-- User: ops dashboard mediator-scoped queries
CREATE INDEX IF NOT EXISTS "users_mediatorCode_isDeleted_status_idx" ON "users"("mediatorCode", "isDeleted", "status");

-- User: agency team listing
CREATE INDEX IF NOT EXISTS "users_parentCode_isDeleted_status_idx" ON "users"("parentCode", "isDeleted", "status");

-- Transaction: ledger queries with type filter
CREATE INDEX IF NOT EXISTS "transactions_walletId_type_createdAt_idx" ON "transactions"("walletId", "type", "createdAt" DESC);

-- Ticket: permission checks
CREATE INDEX IF NOT EXISTS "tickets_userId_orderId_isDeleted_idx" ON "tickets"("userId", "orderId", "isDeleted");

-- Ticket: role-scoped ticket queries
CREATE INDEX IF NOT EXISTS "tickets_role_status_isDeleted_idx" ON "tickets"("role", "status", "isDeleted");
