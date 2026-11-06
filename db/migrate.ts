import fs from "node:fs";
import path from "node:path";
import pg from "pg";

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
  );
  const dir = path.join(process.cwd(), "db");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const done = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [f]);
    if (done.rowCount) {
      console.log(`skip  ${f}`);
      continue;
    }
    console.log(`apply ${f}`);
    try {
      await client.query("BEGIN");
      await client.query(fs.readFileSync(path.join(dir, f), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  }
  await client.end();
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});