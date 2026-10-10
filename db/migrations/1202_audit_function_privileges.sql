-- Audit integrity (tender §65): only the application roles may append to the ledger. Functions are executable by PUBLIC
-- by default, so any other role that can log in (e.g. ksp_backup) could otherwise call the SECURITY DEFINER
-- audit_append(). Direct INSERT / UPDATE / DELETE / TRUNCATE on audit_events stay revoked (0002) and trigger-guarded.
REVOKE ALL ON FUNCTION audit_append(text,text,text,inet,text,uuid,text,text,text,text,text,uuid,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_append(text,text,text,inet,text,uuid,text,text,text,text,text,uuid,uuid,uuid,jsonb) TO ksp_app, ksp_ai;
