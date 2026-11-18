const USER_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active BOOLEAN DEFAULT 1,
    git_name TEXT,
    git_email TEXT,
    has_completed_onboarding BOOLEAN DEFAULT 0
);
`;

export const API_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key_name TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used DATETIME,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_CREDENTIALS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credential_name TEXT NOT NULL,
    credential_type TEXT NOT NULL, -- 'github_token', 'gitlab_token', 'bitbucket_token', etc.
    credential_value TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id INTEGER PRIMARY KEY,
    preferences_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const VAPID_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vapid_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    keys_p256dh TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const PROJECTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY NOT NULL,
    project_path TEXT NOT NULL UNIQUE,
    custom_project_name TEXT DEFAULT NULL,
    isStarred BOOLEAN DEFAULT 0,
    isArchived BOOLEAN DEFAULT 0
);
`;

export const SESSIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'claude',
    custom_name TEXT,
    name_is_custom INTEGER,
    project_path TEXT,
    jsonl_path TEXT,
    isArchived BOOLEAN DEFAULT 0,
    isStarred BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id),
    FOREIGN KEY (project_path) REFERENCES projects(project_path)
    ON DELETE SET NULL
    ON UPDATE CASCADE
);
`;

export const LAST_SCANNED_AT_SQL = `
CREATE TABLE IF NOT EXISTS scan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scanned_at TIMESTAMP NULL
);
`;

export const APP_CONFIG_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

// 每個 session 最後使用的模型。獨立成表而不放進 sessions：
// 新 session 在 `session_created` 時就要寫入，此時 sessions 列可能尚未由同步器建立
export const SESSION_MODELS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_models (
    session_id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const SESSION_MESSAGES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_messages (
    session_id TEXT NOT NULL,
    id TEXT NOT NULL,
    seq REAL NOT NULL,
    provider_ids TEXT NOT NULL DEFAULT '[]',
    payload TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('live', 'import')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_messages_session_seq
    ON session_messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_session_messages_session_updated
    ON session_messages(session_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_session_messages_id
    ON session_messages(id);
CREATE INDEX IF NOT EXISTS idx_session_messages_tool_id
    ON session_messages(session_id, json_extract(payload, '$.toolId'));
`;

// 多 Agent（聊天室 / 工作流）。definition_json 由 shared/multiAgent.ts 型別約束；
// runs / turns 保存當時的定義快照，修改定義不影響歷史。
export const MULTI_AGENT_TABLES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS multi_agents (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('chatroom', 'workflow')),
    name TEXT NOT NULL,
    definition_json TEXT,
    definition_version INTEGER NOT NULL DEFAULT 0,
    builder_session_json TEXT,
    member_sessions_json TEXT NOT NULL DEFAULT '{}',
    workspace_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_multi_agents_user ON multi_agents(user_id, updated_at);

CREATE TABLE IF NOT EXISTS multi_agent_runs (
    id TEXT PRIMARY KEY,
    multi_agent_id TEXT NOT NULL,
    status TEXT NOT NULL,
    definition_version INTEGER NOT NULL,
    definition_snapshot_json TEXT NOT NULL,
    node_states_json TEXT NOT NULL DEFAULT '{}',
    start_input TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_multi_agent_runs_agent ON multi_agent_runs(multi_agent_id, started_at);

CREATE TABLE IF NOT EXISTS multi_agent_turns (
    id TEXT PRIMARY KEY,
    multi_agent_id TEXT NOT NULL,
    trigger_message_id TEXT NOT NULL,
    status TEXT NOT NULL,
    definition_snapshot_json TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_multi_agent_turns_agent ON multi_agent_turns(multi_agent_id, started_at);

CREATE TABLE IF NOT EXISTS multi_agent_messages (
    id TEXT PRIMARY KEY,
    multi_agent_id TEXT NOT NULL,
    turn_id TEXT,
    seq INTEGER NOT NULL,
    author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'member', 'system')),
    member_id TEXT,
    author_snapshot_json TEXT,
    content TEXT NOT NULL,
    status TEXT NOT NULL,
    finish_reason TEXT,
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_multi_agent_messages_seq ON multi_agent_messages(multi_agent_id, seq);

-- 工作流節點產生的 provider 會話：側邊欄與檢索排除、聊天頁顯示節點標記（node-live-session D2）
CREATE TABLE IF NOT EXISTS workflow_sessions (
    session_id TEXT PRIMARY KEY,
    multi_agent_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_sessions_agent ON workflow_sessions(multi_agent_id);
`;

export const INIT_SCHEMA_SQL = `
-- Initialize authentication database
PRAGMA foreign_keys = ON;

${USER_TABLE_SCHEMA_SQL}
-- Indexes for performance for user lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

${API_KEYS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

${USER_CREDENTIALS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_credentials_user_id ON user_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_user_credentials_type ON user_credentials(credential_type);
CREATE INDEX IF NOT EXISTS idx_user_credentials_active ON user_credentials(is_active);

${USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_notification_preferences_user_id ON user_notification_preferences(user_id);

${VAPID_KEYS_TABLE_SCHEMA_SQL}

${PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);

${PROJECTS_TABLE_SCHEMA_SQL}
-- NOTE: These indexes are created in migrations after legacy table-shape repairs.
-- Creating them here can fail on upgraded installs where projects lacks those columns.

${SESSIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_session_ids_lookup ON sessions(session_id);
-- NOTE: This index is created in migrations after sessions is rebuilt to include project_path.
-- Creating it here can fail on upgraded installs where the legacy sessions table has no project_path.

${LAST_SCANNED_AT_SQL}

${APP_CONFIG_TABLE_SCHEMA_SQL}

${SESSION_MODELS_TABLE_SCHEMA_SQL}

${SESSION_MESSAGES_TABLE_SCHEMA_SQL}

${MULTI_AGENT_TABLES_SCHEMA_SQL}
`;
