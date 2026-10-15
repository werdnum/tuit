-- Push notifications: each person's rules and quiet hours, the devices that receive them, and a
-- log of what was sent (or held for quiet hours). The log keeps ids, never titles: a
-- notification is rendered when it is delivered, through the visibility filter.

-- Server-generated secrets that need no operator, e.g. the Web Push (VAPID) key pair.
CREATE TABLE server_keys (
  name text PRIMARY KEY,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notify_settings (
  user_id text PRIMARY KEY REFERENCES users(id),
  -- The last feed position this person's notifications were decided for.
  cursor bigint NOT NULL,
  quiet_from time,
  quiet_to time,
  rules jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE notify_devices (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('web', 'apns')),
  -- A Web Push endpoint URL, or an APNs device token.
  address text NOT NULL,
  -- Web Push: the subscription's p256dh and auth keys.
  keys jsonb,
  -- APNs: 'sandbox' (development builds) or 'production'.
  environment text CHECK (environment IN ('sandbox', 'production')),
  label text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  last_sent_at timestamptz,
  last_error text,
  UNIQUE (kind, address)
);

CREATE TABLE notify_log (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  -- The first feed event of the change it reports. Unique per person, so a change is never
  -- reported twice, however often dispatch runs.
  seq bigint NOT NULL,
  task_id text NOT NULL REFERENCES tasks(id),
  category text NOT NULL,
  rule_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('sent', 'held', 'undelivered')),
  created_at timestamptz NOT NULL,
  sent_at timestamptz,
  UNIQUE (user_id, seq)
);
CREATE INDEX notify_log_held ON notify_log (user_id) WHERE status = 'held';
