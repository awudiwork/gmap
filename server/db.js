/**
 * 持久化边界：SQLite 连接与表结构迁移。
 *
 * 契约：
 *  - 本模块只负责"连上库 + 把库升到最新结构"，不含任何业务查询。
 *  - 迁移通过 PRAGMA user_version 记录版本，按数组下标顺序执行，只增不改：
 *    已发布的迁移语句永不修改，新结构一律追加新条目。
 */
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from './config.js'

fs.mkdirSync(config.dataDir, { recursive: true })

export const db = new Database(path.join(config.dataDir, 'gmap.db'))

db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 5000')

/** 迁移列表：索引 + 1 即为迁移后的 user_version */
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL COLLATE NOCASE UNIQUE,
    display_name  TEXT    NOT NULL,
    password_hash TEXT    NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_expires ON sessions(expires_at);

  CREATE TABLE api_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT    NOT NULL,
    key_hash     TEXT    NOT NULL UNIQUE,
    key_prefix   TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at   INTEGER
  );
  CREATE INDEX idx_api_keys_user ON api_keys(user_id);

  CREATE TABLE files (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stored_name   TEXT    NOT NULL UNIQUE,
    original_name TEXT    NOT NULL,
    mime          TEXT    NOT NULL,
    category      TEXT    NOT NULL,
    size          INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    deleted_at    INTEGER
  );
  CREATE INDEX idx_files_pending_cleanup ON files(expires_at) WHERE deleted_at IS NULL;

  CREATE TABLE messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT    NOT NULL,
    body       TEXT,
    lang       TEXT,
    file_id    INTEGER REFERENCES files(id) ON DELETE SET NULL,
    source     TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_messages_id_desc ON messages(id DESC);
  `,

  // v2：用户改为软删除。物理删除会经外键级联带走该用户的全部聊天记录，
  // 在历史里留下空洞；这里只注销凭据，消息作者仍可解析。
  `
  ALTER TABLE users ADD COLUMN deleted_at INTEGER;
  `,

  // v3：API Key 改为直接删除。Key 和用户不同，它不挂着任何历史内容，
  // 留一行"已吊销"记录只是让列表越来越长，没有人会去读。
  `
  DELETE FROM api_keys WHERE revoked_at IS NOT NULL;
  ALTER TABLE api_keys DROP COLUMN revoked_at;
  `,
]

function migrate() {
  const current = db.pragma('user_version', { simple: true })
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const sql = MIGRATIONS[version]
    db.transaction(() => {
      db.exec(sql)
      db.pragma(`user_version = ${version + 1}`)
    })()
    console.log(`[db] 已应用迁移 v${version + 1}`)
  }
}

migrate()
