-- Per-person priority replaces the pin: 0 = P0 (the old pin), 1 = P1 (the default), 2 = P2.
ALTER TABLE attention ADD COLUMN priority smallint NOT NULL DEFAULT 1 CHECK (priority BETWEEN 0 AND 2);
UPDATE attention SET priority = 0 WHERE pinned;
ALTER TABLE attention DROP COLUMN pinned;

-- Saved queues name their ordering rules: "pinned" is now "priority", and "recent_handoff" is
-- now "follow_up" (a lapsed claim or a due follow-up; a recent handoff no longer ranks).
UPDATE queues SET config = jsonb_set(config, '{order}', (
  SELECT coalesce(jsonb_agg(CASE r WHEN 'pinned' THEN 'priority' WHEN 'recent_handoff' THEN 'follow_up' ELSE r END ORDER BY i), '[]'::jsonb)
  FROM jsonb_array_elements_text(config->'order') WITH ORDINALITY AS o(r, i)
))
WHERE jsonb_typeof(config->'order') = 'array';
