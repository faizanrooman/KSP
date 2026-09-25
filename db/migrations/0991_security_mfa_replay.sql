-- Security round 2 (SEC-12): TOTP replay protection. The last accepted TOTP time step is stored per user; a code
-- is accepted only for a step strictly greater than the last one (RFC 6238 §5.2: "the verifier MUST NOT accept the
-- second attempt of the OTP after the successful validation has been issued for the first OTP").
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_totp_step bigint;
COMMENT ON COLUMN users.mfa_last_totp_step IS 'Last accepted TOTP time step (unix time / 30); codes for this or an earlier step are refused (replay).';
