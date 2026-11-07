-- batched: arrived within a burst of notifications; sent as part of one summary once it settles.
ALTER TABLE notify_log DROP CONSTRAINT notify_log_status_check;
ALTER TABLE notify_log ADD CONSTRAINT notify_log_status_check
  CHECK (status IN ('sent', 'held', 'retry', 'batched', 'undelivered'));
DROP INDEX notify_log_pending;
CREATE INDEX notify_log_pending ON notify_log (user_id) WHERE status IN ('held', 'retry', 'batched');
