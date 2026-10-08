-- 1151: archive of every certificate that has signed audit checkpoints / export manifests (EXT-3 key rotation).
-- When the signing key changes (dev key -> HSM key, certificate renewal) earlier checkpoints must still verify with
-- the certificate that signed them, identified by audit_checkpoints.cert_fingerprint. Append-only.
CREATE TABLE signing_certificates (
  fingerprint256  text PRIMARY KEY,               -- X509Certificate.fingerprint256 (AA:BB:... upper-case hex)
  key_id          text NOT NULL,
  provider        text NOT NULL,                  -- pem | pkcs11
  non_evidentiary boolean NOT NULL,               -- development / self-signed test certificate
  certificate_pem text NOT NULL,
  first_used_at   timestamptz NOT NULL DEFAULT now()
);
REVOKE UPDATE, DELETE, TRUNCATE ON signing_certificates FROM ksp_app;
CREATE TRIGGER signing_certificates_no_update BEFORE UPDATE OR DELETE ON signing_certificates FOR EACH ROW EXECUTE FUNCTION audit_block_mutation();
