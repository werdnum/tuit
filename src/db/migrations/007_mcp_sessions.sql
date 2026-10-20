-- MCP sessions, kept so resource subscriptions survive a restart: a client's event stream
-- reconnects and catches up from where it left off. A session belongs to one agent acting for
-- one person; requests from anyone else can't use it.
CREATE TABLE mcp_sessions (
  id text PRIMARY KEY,
  user_id text REFERENCES users(id),
  agent text,
  -- The last feed position this session's subscriptions were checked against.
  cursor bigint NOT NULL,
  subscriptions text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  seen_at timestamptz NOT NULL
);
CREATE INDEX mcp_sessions_seen ON mcp_sessions (seen_at);
