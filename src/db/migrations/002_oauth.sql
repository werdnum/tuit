-- OAuth for remote MCP connectors (claude.ai, ChatGPT). An approved connector gets an ordinary
-- agent token acting for the person who approved it; there is no separate permission model.
CREATE TABLE oauth_clients (
  id text PRIMARY KEY,
  name text NOT NULL,
  redirect_uris text[] NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE oauth_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(id),
  user_id text NOT NULL REFERENCES users(id),
  agent text NOT NULL,
  scope text NOT NULL,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE oauth_refresh (
  token_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(id),
  access_token_id text NOT NULL REFERENCES tokens(id),
  created_at timestamptz NOT NULL,
  used_at timestamptz
);

ALTER TABLE tokens ADD COLUMN expires_at timestamptz;
ALTER TABLE tokens ADD COLUMN oauth_client_id text REFERENCES oauth_clients(id);
