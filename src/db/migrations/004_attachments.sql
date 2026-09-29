-- Links to files kept elsewhere (usually Google Drive). Tuit never stores the files themselves.
ALTER TABLE tasks ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]';
