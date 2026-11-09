-- Agents that sign in through the external issuer (claude.ai, ChatGPT) hold no row in tokens:
-- their access tokens are verified, never stored. Remembering who has connected lets the web
-- app offer them by name when handing a task off.
CREATE TABLE connector_agents (
  user_id text NOT NULL REFERENCES users(id),
  agent text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, agent)
);
