-- 1150: AI legal gates (EXT-4 / EXT-5). The isolated AI worker (ksp_ai) must re-check the legal approvals recorded
-- in system_settings.aiLegalApprovals before it runs a job, but it must not read any other setting. This view
-- exposes exactly that one value; ksp_ai gets SELECT on the view only (views execute with the owner's rights).
CREATE VIEW ai_legal_approvals AS
  SELECT value FROM system_settings WHERE key = 'aiLegalApprovals';
REVOKE ALL ON ai_legal_approvals FROM PUBLIC;
GRANT SELECT ON ai_legal_approvals TO ksp_ai;
GRANT SELECT ON ai_legal_approvals TO ksp_app;
