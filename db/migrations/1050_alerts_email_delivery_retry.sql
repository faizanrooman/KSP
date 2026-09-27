-- 1050: alert e-mail channel + retried external deliveries (FN-1).
--  * alert_rules.email_recipients: extra (non-user) addresses notified for this rule, in addition to the
--    e-mail addresses of alerts:manage holders in scope and the per-severity recipients (alertDeliveryPolicy).
--  * alert_deliveries stays append-only: every attempt is a row. RETRYING = the attempt failed and another
--    attempt is scheduled at next_attempt_at (queue alerts.deliver); FAILED = final failure (attempts exhausted).
ALTER TABLE alert_rules ADD COLUMN email_recipients text[] NOT NULL DEFAULT '{}';

ALTER TABLE alert_deliveries ADD COLUMN attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1);
ALTER TABLE alert_deliveries ADD COLUMN next_attempt_at timestamptz;
ALTER TABLE alert_deliveries DROP CONSTRAINT IF EXISTS alert_deliveries_status_check;
ALTER TABLE alert_deliveries ADD CONSTRAINT alert_deliveries_status_check CHECK (status IN ('SENT','FAILED','SKIPPED','RETRYING'));
CREATE INDEX alert_deliveries_failures ON alert_deliveries (created_at DESC) WHERE status IN ('FAILED','RETRYING');
