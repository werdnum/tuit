-- A task can be part of one other task (one level: a part has no parts of its own).
ALTER TABLE tasks ADD COLUMN parent_id text REFERENCES tasks(id);
CREATE INDEX tasks_parent_idx ON tasks (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX events_task_idx ON events (task_id, seq) WHERE task_id IS NOT NULL;
