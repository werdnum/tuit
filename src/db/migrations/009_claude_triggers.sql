-- Claude Code triggers (TUIT_CLAUDE_TRIGGERS), keyed by fire URL. `fired` lists the tasks that
-- have been claimable by the agent ever since a fire covered them, so a task waiting for the
-- agent starts one session, not one per restart or sweep. A task that is claimed, closed, held
-- or handed elsewhere leaves the list, and fires again if it comes back.
CREATE TABLE claude_triggers (
  url text PRIMARY KEY,
  fired jsonb NOT NULL DEFAULT '[]',
  last_fired_at timestamptz,
  last_session_url text,
  last_error text
);
