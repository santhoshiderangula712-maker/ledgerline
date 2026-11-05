import Fastify from "fastify";
import pg from "pg";

const app = Fastify({ logger: true });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

app.get("/health", async () => {
  const { rows } = await pool.query("SELECT 1 AS ok");
  return { status: "ok", db: rows[0].ok === 1 };
});

app.listen({ port: Number(process.env.PORT) || 3000, host: "0.0.0.0" });