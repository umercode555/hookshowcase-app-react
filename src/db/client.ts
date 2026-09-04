import Database from "@tauri-apps/plugin-sql";

// Single shared connection. tauri-plugin-sql handles pooling; this module
// just keeps every query going through one typed surface so no code outside
// db/ ever writes raw SQL, mirroring how the old app centralized everything
// through idbPut/idbGet/idbGetAll — but with real transactions and indexes
// instead of a hand-rolled cache Map.

let _db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (_db) return _db;
  _db = await Database.load("sqlite:hookshowcase.db");
  return _db;
}

export async function migrate(): Promise<void> {
  const db = await getDb();
  const schema = await (await fetch(new URL("./schema.sql", import.meta.url))).text();
  // sqlite driver here executes one statement at a time
  for (const stmt of schema.split(";").map((s) => s.trim()).filter(Boolean)) {
    await db.execute(stmt);
  }
}

export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await getDb();
  return db.select<T[]>(sql, params);
}

export async function exec(sql: string, params: unknown[] = []): Promise<void> {
  const db = await getDb();
  await db.execute(sql, params);
}
