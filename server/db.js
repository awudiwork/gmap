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

  // v4：消息也有保留期，房间变成一个滚动窗口。
  // 到期时间在落库那一刻算好，之后改配置只影响新消息，
  // 不会让人把保留期调短之后眼睁睁看着历史当场蒸发。
  // 存量消息的 expires_at 是 NULL，清理时按"创建时间 + 当前配置"兜底。
  // 同时清掉 files.deleted_at：文件不再"标记删除后留档"，它跟着消息一起物理消失，
  // 那一列从此永远是 NULL。索引引用着它，得先删索引。
  `
  ALTER TABLE messages ADD COLUMN expires_at INTEGER;
  CREATE INDEX idx_messages_expires ON messages(expires_at);
  DROP INDEX idx_files_pending_cleanup;
  DELETE FROM files WHERE deleted_at IS NOT NULL;
  ALTER TABLE files DROP COLUMN deleted_at;
  `,

  // v5：消息按游戏分房间。存量消息落到 all，那本来就是它们的去处。
  // 索引带上 id DESC，因为读取永远是"某个房间的最近 N 条"。
  `
  ALTER TABLE messages ADD COLUMN room TEXT NOT NULL DEFAULT 'all';
  CREATE INDEX idx_messages_room ON messages(room, id DESC);
  `,

  // v6：messages.file_id 有外键却没索引。清理事务里每删一条 files 行，
  // SQLite 都要全表扫 messages 来维护 ON DELETE SET NULL，一轮 500 条就是 500 次全表扫。
  `
  CREATE INDEX idx_messages_file ON messages(file_id);
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
