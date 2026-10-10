-- Tender §57/§68: disposal before the end of the retention period (or of evidence kept indefinitely) needs a court or
-- government order. The request records whether it was early, the retention date at that moment and the authority;
-- the approver sees it and must confirm it explicitly.
ALTER TABLE disposal_requests ADD COLUMN early boolean NOT NULL DEFAULT false;
ALTER TABLE disposal_requests ADD COLUMN retain_until_at_request timestamptz;
ALTER TABLE disposal_requests ADD COLUMN authority_type text CHECK (authority_type IN ('RETENTION_EXPIRED', 'COURT_ORDER', 'GOVERNMENT_ORDER'));
ALTER TABLE disposal_requests ADD COLUMN authority_date date;
COMMENT ON COLUMN disposal_requests.early IS 'true = requested before evidence.retain_until (or retention indefinite): requires a COURT_ORDER / GOVERNMENT_ORDER authority';
