import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 10000,
});

// A dropped idle connection must not crash or poison the pool.
pool.on("error", (err) => {
  console.error("idle pg client error", err.message);
});