-- A task merged into a surviving task (closed as expired with a pointer to the survivor).
ALTER TABLE tasks ADD COLUMN merged_into text REFERENCES tasks(id);
CREATE INDEX tasks_merged_into_idx ON tasks (merged_into) WHERE merged_into IS NOT NULL;

-- Machine-managed correlation keys (e.g. alert keys, image refs) stored out-of-band from the
-- human-readable brief. Merging a task unions its external_keys onto the surviving target.
ALTER TABLE tasks ADD COLUMN external_keys jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX tasks_external_keys_idx ON tasks USING gin (external_keys);
