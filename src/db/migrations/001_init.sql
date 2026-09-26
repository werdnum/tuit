CREATE TABLE users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL
);

CREATE TABLE sessions (
  id_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

-- An agent token is issued by a human and acts for that human as a named agent; a personal
-- token is the human themself (their own CLI); a display token has no user and sees
-- household items only.
CREATE TABLE tokens (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('agent', 'personal', 'display')),
  user_id text REFERENCES users(id),
  agent text,
  scope text NOT NULL CHECK (scope IN ('read', 'write')),
  label text NOT NULL DEFAULT '',
  issued_by text REFERENCES users(id),
  created_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  CHECK ((kind = 'agent' AND user_id IS NOT NULL AND agent IS NOT NULL)
      OR (kind = 'personal' AND user_id IS NOT NULL AND agent IS NULL)
      OR (kind = 'display' AND user_id IS NULL AND scope = 'read'))
);

CREATE TABLE tasks (
  id text PRIMARY KEY,
  seq bigserial UNIQUE,
  title text NOT NULL,
  brief text NOT NULL DEFAULT '',
  next_action text NOT NULL DEFAULT '',
  done_means text NOT NULL DEFAULT '',
  owner_id text NOT NULL REFERENCES users(id),
  visibility text NOT NULL DEFAULT 'household' CHECK (visibility IN ('household', 'private')),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'agent', 'anyone')),
  actor_user text REFERENCES users(id),
  actor_agent text,
  actor_since timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'waiting', 'done', 'expired', 'shelved')),
  close_reason text NOT NULL DEFAULT '',
  closed_at timestamptz,
  waiting_kind text CHECK (waiting_kind IN ('reply', 'until', 'task')),
  waiting_for text NOT NULL DEFAULT '',
  waiting_task_id text REFERENCES tasks(id),
  waiting_since timestamptz,
  follow_up_date date,
  follow_up_at timestamptz,
  available_from_date date,
  available_from_at timestamptz,
  available_rule jsonb,
  target_date date,
  target_at timestamptz,
  target_rule jsonb,
  deadline_date date,
  deadline_at timestamptz,
  expires_date date,
  expires_at timestamptz,
  requires text[] NOT NULL DEFAULT '{}',
  prefers text[] NOT NULL DEFAULT '{}',
  recurrence jsonb,
  last_done_at timestamptz,
  last_skip_at timestamptz,
  claim_id text,
  claim_agent text,
  claim_user text REFERENCES users(id),
  claim_expires_at timestamptz,
  claim_side_effects boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  created_by_user text REFERENCES users(id),
  created_by_agent text,
  CHECK (actor_kind <> 'user' OR actor_user IS NOT NULL),
  CHECK (actor_kind <> 'agent' OR actor_agent IS NOT NULL),
  CHECK (follow_up_date IS NULL OR follow_up_at IS NULL),
  CHECK (available_from_date IS NULL OR available_from_at IS NULL),
  CHECK (target_date IS NULL OR target_at IS NULL),
  CHECK (deadline_date IS NULL OR deadline_at IS NULL),
  CHECK (expires_date IS NULL OR expires_at IS NULL),
  CHECK ((state = 'waiting') = (waiting_kind IS NOT NULL))
);
CREATE INDEX tasks_state_idx ON tasks (state);

-- Per-person attention: snooze and pin never touch shared task dates.
CREATE TABLE attention (
  user_id text NOT NULL REFERENCES users(id),
  task_id text NOT NULL REFERENCES tasks(id),
  snoozed_until timestamptz,
  pinned boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, task_id)
);

CREATE TABLE activity (
  id bigserial PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id),
  kind text NOT NULL,
  body text NOT NULL DEFAULT '',
  data jsonb NOT NULL DEFAULT '{}',
  happened_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  author_user text REFERENCES users(id),
  author_agent text
);
CREATE INDEX activity_task_idx ON activity (task_id, id);

CREATE TABLE events (
  seq bigserial PRIMARY KEY,
  type text NOT NULL,
  task_id text REFERENCES tasks(id),
  queue_id text,
  at timestamptz NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  actor_user text,
  actor_agent text
);

-- Once-only markers for time-driven events emitted by the sweep.
CREATE TABLE sweep_marks (
  task_id text NOT NULL REFERENCES tasks(id),
  mark text NOT NULL,
  mark_key text NOT NULL,
  PRIMARY KEY (task_id, mark, mark_key)
);

CREATE TABLE idempotency (
  principal text NOT NULL,
  key text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (principal, key)
);

CREATE TABLE queues (
  id text PRIMARY KEY,
  name text NOT NULL,
  owner_id text NOT NULL REFERENCES users(id),
  visibility text NOT NULL DEFAULT 'household' CHECK (visibility IN ('household', 'private')),
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  created_by_agent text
);

-- The Now shortlist is sticky for a local day so finishing items does not slide in replacements.
CREATE TABLE day_plans (
  user_id text NOT NULL REFERENCES users(id),
  local_date date NOT NULL,
  task_ids text[] NOT NULL,
  -- Everything already eligible when the plan was made; anything else is "new".
  seen_ids text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  enough_until timestamptz,
  PRIMARY KEY (user_id, local_date)
);

-- When each credential last looked at Now, for the "while you were away" summary. Per
-- credential so an agent polling Now doesn't hide the summary from the person.
CREATE TABLE now_seen (
  principal text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL
);
