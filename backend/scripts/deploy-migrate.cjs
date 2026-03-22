#!/usr/bin/env node
/**
 * Direct SQL migration runner — bypasses Prisma CLI entirely.
 * Used as fallback when `prisma migrate deploy` or `prisma db push`
 * fail due to hosted PostgreSQL permission restrictions.
 *
 * Usage: node scripts/deploy-migrate.cjs
 * Requires: DATABASE_URL env var with search_path set to target schema
 */

const { Client } = require("pg");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MIGRATIONS_DIR = path.join(__dirname, "../prisma/migrations");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }

  const client = new Client({
    connectionString: url,
    ssl: (process.env.DB_SSL_REJECT_UNAUTHORIZED === 'false' || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
      ? { rejectUnauthorized: false }
      : true,
  });

  await client.connect();
  console.log("Connected to database");

  // pg library does not apply search_path from URL — extract and set explicitly
  const urlObj = new URL(url);
  const schemaFromUrl = urlObj.searchParams.get("search_path");
  if (schemaFromUrl) {
    // Validate schema name: only allow alphanumeric, underscores, and commas (for multiple schemas)
    if (!/^[a-zA-Z_][a-zA-Z0-9_,\s]*$/.test(schemaFromUrl)) {
      console.error("Invalid search_path value:", schemaFromUrl);
      process.exit(1);
    }
    await client.query(`SET search_path TO ${schemaFromUrl}`);
    console.log("Set search_path to:", schemaFromUrl);
  }

  // Show current search_path
  const spResult = await client.query("SHOW search_path");
  console.log("search_path:", spResult.rows[0].search_path);

  const schemaResult = await client.query("SELECT current_schema()");
  console.log("current_schema:", schemaResult.rows[0].current_schema);

  // Create _prisma_migrations table if not exists
  let canTrackMigrations = true;
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
        checksum VARCHAR(64) NOT NULL,
        finished_at TIMESTAMPTZ,
        migration_name VARCHAR(255) NOT NULL UNIQUE,
        logs TEXT,
        rolled_back_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ DEFAULT now(),
        applied_steps_count INTEGER DEFAULT 0
      )
    `);
    console.log("_prisma_migrations table ready");
    // Verify we actually have SELECT/INSERT/DELETE permission on the table
    await client.query(`SELECT COUNT(*) FROM "_prisma_migrations"`);
  } catch (tableErr) {
    if (tableErr.message && tableErr.message.includes("permission denied")) {
      console.log("⚠️  Cannot manage _prisma_migrations table (permission denied)");
      console.log("   Table may be owned by a different database role.");
      console.log("   Will apply migrations without tracking (relying on IF NOT EXISTS).");
      canTrackMigrations = false;
    } else {
      throw tableErr;
    }
  }

  // Get sorted migration directories
  const dirs = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((d) => {
      const p = path.join(MIGRATIONS_DIR, d);
      return (
        fs.statSync(p).isDirectory() &&
        fs.existsSync(path.join(p, "migration.sql"))
      );
    })
    .sort();

  console.log(`Found ${dirs.length} migrations: ${dirs.join(", ")}`);

  let applied = 0;
  let skipped = 0;

  for (const dir of dirs) {
    // Check if already applied (only if we can access the tracking table)
    if (canTrackMigrations) {
      const exists = await client.query(
        `SELECT 1 FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL`,
        [dir]
      );
      if (exists.rows.length > 0) {
        // Verify the migration's tables actually exist — a previous CI step may
        // have marked it applied without running the SQL (see prepare-migration).
        const migSqlFile = path.join(MIGRATIONS_DIR, dir, "migration.sql");
        const sqlContent = fs.readFileSync(migSqlFile, "utf8");
        const createMatches = sqlContent.match(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+"?(\w+)"?/gi) || [];
        const tableNames = createMatches.map(s => {
          const m = s.match(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+"?(\w+)"?/i);
          return m ? m[1] : null;
        }).filter(Boolean);

        if (tableNames.length > 0) {
          let allExist = true;
          for (const tbl of tableNames) {
            const tblCheck = await client.query(
              `SELECT 1 FROM information_schema.tables WHERE table_name = $1 AND table_type = 'BASE TABLE'`,
              [tbl]
            );
            if (tblCheck.rows.length === 0) {
              console.log(`⚠️  ${dir} marked applied but table "${tbl}" missing — will re-apply`);
              await client.query(`DELETE FROM "_prisma_migrations" WHERE migration_name = $1`, [dir]);
              allExist = false;
              break;
            }
          }
          if (allExist) {
            console.log(`⏭️  ${dir} (already applied)`);
            skipped++;
            continue;
          }
        } else {
          console.log(`⏭️  ${dir} (already applied)`);
          skipped++;
          continue;
        }
      }

      // Delete any failed/incomplete entries for this migration
      await client.query(
        `DELETE FROM "_prisma_migrations" WHERE migration_name = $1`,
        [dir]
      );
    }

    const sqlFile = path.join(MIGRATIONS_DIR, dir, "migration.sql");
    const sql = fs.readFileSync(sqlFile, "utf8");
    const checksum = crypto.createHash("sha256").update(sql).digest("hex");

    console.log(`🔧 Applying: ${dir}`);

    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");

      // Record as applied (only if tracking is available)
      if (canTrackMigrations) {
        await client.query(
          `INSERT INTO "_prisma_migrations" (checksum, migration_name, finished_at, applied_steps_count) VALUES ($1, $2, now(), 1)`,
          [checksum, dir]
        );
      }
      console.log(`✅ ${dir}`);
      applied++;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});

      // When we can't track migrations, permission errors on existing tables
      // are expected — the tables already exist and are owned by another role.
      // Skip gracefully instead of failing the entire deploy.
      if (!canTrackMigrations && e.message && e.message.includes("permission denied")) {
        console.log(`⏭️  ${dir} (skipped — permission denied, tables likely already exist)`);
        skipped++;
        continue;
      }

      console.error(`❌ ${dir}: ${e.message}`);

      // For non-baseline migrations (which use IF NOT EXISTS),
      // try executing without transaction wrapper
      if (dir !== "0_baseline") {
        console.log(`   Retrying ${dir} without transaction...`);
        try {
          await client.query(sql);
          if (canTrackMigrations) {
            await client.query(
              `INSERT INTO "_prisma_migrations" (checksum, migration_name, finished_at, applied_steps_count) VALUES ($1, $2, now(), 1)`,
              [checksum, dir]
            );
          }
          console.log(`✅ ${dir} (retry succeeded)`);
          applied++;
        } catch (e2) {
          console.error(`❌ ${dir} retry failed: ${e2.message}`);
          await client.end();
          process.exit(1);
        }
      } else {
        console.error(
          "Baseline migration failed — cannot continue. Error details above."
        );
        await client.end();
        process.exit(1);
      }
    }
  }

  await client.end();
  console.log(
    `\n✅ Migration complete: ${applied} applied, ${skipped} skipped`
  );
}

main().catch((e) => {
  console.error("Fatal error:", e.message);
  console.error(e.stack);
  process.exit(1);
});
