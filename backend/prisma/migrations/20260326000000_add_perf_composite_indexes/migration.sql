-- Performance composite indexes for high-traffic query patterns

-- User: ops dashboard mediator-scoped queries
CREATE INDEX IF NOT EXISTS "users_mediator_code_is_deleted_status_idx" ON "users"("mediator_code", "is_deleted", "status");

-- User: agency team listing
CREATE INDEX IF NOT EXISTS "users_parent_code_is_deleted_status_idx" ON "users"("parent_code", "is_deleted", "status");

-- Transaction: ledger queries with type filter
CREATE INDEX IF NOT EXISTS "transactions_wallet_id_type_created_at_idx" ON "transactions"("wallet_id", "type", "created_at" DESC);

-- Ticket: permission checks
CREATE INDEX IF NOT EXISTS "tickets_user_id_order_id_is_deleted_idx" ON "tickets"("user_id", "order_id", "is_deleted");

-- Ticket: role-scoped ticket queries
CREATE INDEX IF NOT EXISTS "tickets_role_status_is_deleted_idx" ON "tickets"("role", "status", "is_deleted");
