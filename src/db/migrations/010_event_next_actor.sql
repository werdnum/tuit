-- Whose turn the task was once the write that logged an event committed. Readers judge whether
-- an event touched someone's inbox by this, not by the task's current state, which may have moved
-- on by the time a slow reader gets to the event. NULL on events logged before this column.
ALTER TABLE events
  ADD COLUMN next_actor_kind text,
  ADD COLUMN next_actor_user text,
  ADD COLUMN next_actor_agent text;
