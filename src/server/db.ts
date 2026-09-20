import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { DATA_DIR, DB_PATH } from "./config.ts";

mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    hook TEXT NOT NULL,
    category TEXT NOT NULL,
    year TEXT NOT NULL DEFAULT '',
    place TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    hero_image TEXT,
    moments TEXT NOT NULL DEFAULT '[]',
    sources TEXT NOT NULL DEFAULT '[]',
    production_note TEXT NOT NULL DEFAULT '',
    scripts TEXT,                 -- json { long, short } once written
    published INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    story_id TEXT NOT NULL REFERENCES stories(id),
    state TEXT NOT NULL,
    step TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    error TEXT,
    mock INTEGER NOT NULL DEFAULT 1,
    estimated_cost REAL NOT NULL DEFAULT 0,
    approved_max REAL NOT NULL DEFAULT 0,
    spent REAL NOT NULL DEFAULT 0,
    preview TEXT,                 -- json VisualPreview once ready
    preview_approved INTEGER NOT NULL DEFAULT 0,
    scratch TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    story_id TEXT NOT NULL REFERENCES stories(id),
    job_id TEXT NOT NULL REFERENCES jobs(id),
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    duration_sec REAL NOT NULL,
    fps REAL NOT NULL,
    has_audio INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Cached discovery niches (trending / popular / recommended). One row per kind.
  CREATE TABLE IF NOT EXISTS niche_cache (
    kind TEXT PRIMARY KEY,
    payload TEXT NOT NULL,       -- json { niches: NicheItem[] }
    computed_at TEXT NOT NULL
  );
`);

// Lightweight migrations for databases created before a column existed.
const storyCols = db.prepare(`PRAGMA table_info(stories)`).all() as { name: string }[];
if (!storyCols.some((c) => c.name === "published")) {
  db.exec(`ALTER TABLE stories ADD COLUMN published INTEGER NOT NULL DEFAULT 0`);
}

export function now(): string {
  return new Date().toISOString();
}
