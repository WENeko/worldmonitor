// archive.mjs — append-only SQLite archive for feed-intel.
//
// Purpose: keep a permanent, queryable history of what the layer saw and when,
// so the Macro Director's decisions can be backtested point-in-time ("what did
// the layer know when the directive was issued") and source quality can be
// measured over weeks ("which source broke X first", "how often is a source
// wrong"). The rolling 72 h JSON snapshots cannot answer those questions.
//
// Two tables, both append-only:
//   items  — one row per first-seen item, deduped by (sourceId::itemId).
//            first_seen_at is when feed-intel first observed the item.
//   polls  — one row per source per poll (fetched/new counts + ok flag),
//            the raw material for per-source reliability statistics.
//
// Implementation notes:
//   - Node builtins only: uses `node:sqlite` (bundled since Node 22.5).
//     Imported lazily so an exotic runtime without it degrades to "no archive"
//     instead of killing the poller loop.
//   - WAL mode so Hermès can read the DB read-only (via its ro mount of the
//     shared volume) while feed-intel keeps writing.
//   - INSERT OR IGNORE on the PK fingerprint makes the archive idempotent:
//     re-polling the same item never duplicates a row.

import path from 'node:path';

// DB lives next to the JSON snapshots by default (same volume as the state
// dir), so the Hermès container sees it at /opt/data/feed-intel/archive.sqlite.
export const DEFAULT_ARCHIVE_PATH = (stateDir) => path.join(stateDir, 'archive.sqlite');

// Lazy singleton open. Returns the DatabaseSync handle or null (never throws).
// `failed` latches so a broken DB is reported once, not spammed per cycle.
let dbHandle = null;
let openFailed = false;

export async function openArchive(dbPath) {
  if (dbHandle || openFailed) return dbHandle;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS items (
        fingerprint   TEXT PRIMARY KEY,   -- '<sourceId>::<itemId>'
        source_id     TEXT NOT NULL,
        source_name   TEXT,
        item_id       TEXT NOT NULL,
        title         TEXT,
        url           TEXT,
        sectors       TEXT,               -- JSON array of sector tags
        lang          TEXT,
        reliability   REAL,               -- source reliability at fetch time
        published_at  TEXT,               -- feed-declared timestamp (ISO or null)
        first_seen_at TEXT NOT NULL,      -- when feed-intel first observed it
        fetched_at    TEXT NOT NULL       -- same as first_seen_at on insert
      );
      CREATE INDEX IF NOT EXISTS idx_items_first_seen ON items(first_seen_at);
      CREATE INDEX IF NOT EXISTS idx_items_source ON items(source_id, first_seen_at);
      CREATE INDEX IF NOT EXISTS idx_items_published ON items(published_at);

      CREATE TABLE IF NOT EXISTS polls (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        polled_at TEXT NOT NULL,
        fetched   INTEGER NOT NULL,
        new_items INTEGER NOT NULL,
        ok        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_polls_source ON polls(source_id, polled_at);
    `);
    dbHandle = db;
  } catch (err) {
    openFailed = true;
    console.error(`[feed-intel] archive disabled (${err.message}) — continuing without history`);
  }
  return dbHandle;
}

// Insert only previously-unseen items. Returns the number of rows actually
// written. `sectors` is snapshotted at first sight (the item's sector tags
// are stable per source, so a first-seen record is the honest one).
export function archiveNewItems(db, src, newItems, fetchedAt) {
  if (!db || !newItems || newItems.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO items
      (fingerprint, source_id, source_name, item_id, title, url, sectors,
       lang, reliability, published_at, first_seen_at, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  for (const it of newItems) {
    const res = stmt.run(
      `${src.id}::${it.id}`,
      src.id,
      src.name || null,
      it.id,
      it.title || null,
      it.url || null,
      it.sectors && it.sectors.length ? JSON.stringify(it.sectors) : null,
      it.lang || null,
      typeof src.reliability === 'number' ? src.reliability : null,
      it.publishedAt || null,
      fetchedAt,
      fetchedAt,
    );
    inserted += Number(res.changes);
  }
  return inserted;
}

// Append one poll-stat row per source per cycle.
export function archivePoll(db, src, fetched, newItems, ok) {
  if (!db) return;
  db.prepare(
    'INSERT INTO polls (source_id, polled_at, fetched, new_items, ok) VALUES (?, ?, ?, ?, ?)',
  ).run(src.id, new Date().toISOString(), fetched, newItems, ok ? 1 : 0);
}

// Row counts for --check output.
export function archiveStats(db) {
  if (!db) return { items: 0, polls: 0 };
  const itemRow = db.prepare('SELECT COUNT(*) AS n FROM items').get();
  const pollRow = db.prepare('SELECT COUNT(*) AS n FROM polls').get();
  return { items: Number(itemRow?.n ?? 0), polls: Number(pollRow?.n ?? 0) };
}

export function closeArchive(db) {
  if (!db) return;
  try { db.close(); } catch { /* already closed */ }
}