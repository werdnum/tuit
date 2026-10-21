-- Webhook subscriptions from the MCP Events extension (events/subscribe): Tuit POSTs each
-- matching change to the subscriber's URL, signed with its secret. A subscription belongs to
-- one agent acting for one person, and is keyed by (that principal, url, event name,
-- arguments), so subscribing again refreshes it rather than adding another.
CREATE TABLE webhook_subscriptions (
  id text PRIMARY KEY,
  user_id text REFERENCES users(id),
  agent text,
  -- The credential that subscribed: deliveries stop when that token is revoked.
  credential text NOT NULL,
  name text NOT NULL,
  arguments jsonb NOT NULL,
  url text NOT NULL,
  -- Signing secrets are needed in the clear to sign; the previous one is kept briefly after a
  -- rotation so deliveries carry both signatures while the receiver switches over.
  secret text NOT NULL,
  previous_secret text,
  previous_secret_until timestamptz,
  -- Everything up to here has been delivered or given up on.
  cursor bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz NOT NULL,
  last_delivery_at timestamptz,
  last_error text,
  failed_since timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX webhook_subscriptions_expires ON webhook_subscriptions (expires_at);
CREATE INDEX webhook_subscriptions_owner ON webhook_subscriptions (user_id, agent, url);
