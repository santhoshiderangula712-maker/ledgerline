import pg from "pg";

// The running app uses the restricted role (APP_DATABASE_URL).
// Migrations and tests use DATABASE_URL (the owner). Locally, if APP_DATABASE_URL
// is absent, the app falls back to the owner string.
export const pool = new pg.Pool({
  connectionString: process.env.APP_DATABASE_URL || process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 10000,
});

pool.on("error", (err) => {
  console.error("idle pg client error", err.message);
});