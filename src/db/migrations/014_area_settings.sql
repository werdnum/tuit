-- Household-wide settings for an area. Areas stay plain strings on tasks; a row here only exists
-- once someone changes a setting, and an area with no row has the defaults.
CREATE TABLE area_settings (
  area text PRIMARY KEY CHECK (area ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  -- Leave the area's tasks out of Now and of queues that don't name it.
  hidden_by_default boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL,
  updated_by_user text,
  updated_by_agent text
);
