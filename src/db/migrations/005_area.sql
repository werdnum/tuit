-- One optional, flat area per task ("home", "tuit", "cluster"): which part of life it belongs to.
-- Deliberately not a hierarchy or a tag set; queues and Now can filter on it.
ALTER TABLE tasks ADD COLUMN area text CHECK (area ~ '^[a-z0-9][a-z0-9_-]{0,39}$');
