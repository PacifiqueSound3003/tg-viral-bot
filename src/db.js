import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL manquant");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway Postgres nécessite souvent SSL
  ssl: process.env.DATABASE_URL.includes("rlwy") ? { rejectUnauthorized: false } : undefined,
});

export async function q(text, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

export async function getSetting(key) {
  const r = await q("select value from settings where key=$1 limit 1", [key]);
  return r.rowCount ? r.rows[0].value : null;
}

export async function setSetting(key, value) {
  await q(
    `insert into settings(key, value)
     values ($1,$2)
     on conflict (key) do update set value=excluded.value`,
    [key, String(value)]
  );
}
