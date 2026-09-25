-- 0600: advanced search (saved searches + indexes for every search filter) and investigation workspace
-- support indexes / guards. See docs/SEARCH.md and docs/INVESTIGATION.md.

-- ---------------------------------------------------------------------------------------------
-- Saved searches (per user). criteria = the validated POST /search/evidence body.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE saved_searches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  criteria    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE INDEX saved_searches_user ON saved_searches (user_id, created_at DESC);
CREATE TRIGGER saved_searches_updated BEFORE UPDATE ON saved_searches FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Normalised licence plate: upper-case A-Z0-9 only (same rule as ai_watchlist_entries.plate_normalized).
CREATE OR REPLACE FUNCTION ksp_plate_norm(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT nullif(upper(regexp_replace(coalesce(t, ''), '[^A-Za-z0-9]', '', 'g')), '') $$;

-- ---------------------------------------------------------------------------------------------
-- Evidence search indexes (0003 already has: org_path gist, status, recorded_at, created_at, officer,
-- device, uploaded_by, geo (lat,lon), search_text gin, title trigram).
-- ---------------------------------------------------------------------------------------------
CREATE INDEX evidence_storage_tier ON evidence (storage_tier, created_at DESC);
CREATE INDEX evidence_media_status ON evidence (media_status);
CREATE INDEX evidence_category ON evidence (category) WHERE category IS NOT NULL;
CREATE INDEX evidence_legal_hold ON evidence (created_at DESC) WHERE legal_hold;
CREATE INDEX evidence_number_trgm ON evidence USING gin (evidence_number gin_trgm_ops);
CREATE INDEX evidence_filename_trgm ON evidence USING gin (original_filename gin_trgm_ops);
-- related-evidence suggestions: same officer / device within a time window
CREATE INDEX evidence_officer_recorded ON evidence (officer_id, recorded_at) WHERE officer_id IS NOT NULL;
CREATE INDEX evidence_device_recorded ON evidence (device_id, recorded_at) WHERE device_id IS NOT NULL;
CREATE INDEX evidence_org_unit ON evidence (org_unit_id);

-- AI-derived search (EXISTS on ai_detections). Matching uses the reviewer-corrected label when present.
CREATE INDEX ai_detections_eff_label ON ai_detections (lower(coalesce(corrected_label, label)), review_status);
CREATE INDEX ai_detections_color ON ai_detections (lower(attributes->>'colorName')) WHERE attributes ? 'colorName';
CREATE INDEX ai_detections_plate ON ai_detections (ksp_plate_norm(attributes->>'plateText') text_pattern_ops) WHERE attributes ? 'plateText';
CREATE INDEX ai_detections_watchlist ON ai_detections ((attributes->>'watchlistEntryId')) WHERE attributes ? 'watchlistEntryId';
CREATE INDEX ai_detections_evidence_review ON ai_detections (evidence_id, review_status, frame_time_ms);

-- Case / FIR filters
-- cases_fir (cases.fir_id) is created by 0700_cases_integrations.sql (merged in parallel).
CREATE INDEX firs_number ON firs (upper(fir_number), fir_year);
-- case_members_user (case_members.user_id) is created by 0700_cases_integrations.sql.

-- ---------------------------------------------------------------------------------------------
-- Investigation workspace
-- ---------------------------------------------------------------------------------------------
CREATE INDEX workspace_members_user ON workspace_members (user_id);
CREATE INDEX workspace_items_evidence ON workspace_items (evidence_id);
CREATE INDEX workspace_items_ws ON workspace_items (workspace_id, sort_order);
CREATE INDEX bookmarks_workspace ON bookmarks (workspace_id, evidence_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX bookmarks_user ON bookmarks (user_id, evidence_id);
CREATE INDEX annotations_workspace ON annotations (workspace_id, evidence_id) WHERE workspace_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX evidence_relations_b ON evidence_relations (evidence_b);
CREATE INDEX timeline_events_evidence ON timeline_events (evidence_id) WHERE evidence_id IS NOT NULL;

-- Annotations are soft-deleted only (deleted_at + deleted_by), never physically removed by the app.
ALTER TABLE annotations ADD CONSTRAINT annotations_deleted_by_required CHECK (deleted_at IS NULL OR deleted_by IS NOT NULL);
ALTER TABLE annotations ADD CONSTRAINT annotations_region_shape CHECK (
  kind <> 'REGION' OR (region IS NOT NULL AND jsonb_typeof(region) = 'object'
    AND (region->>'x')::numeric BETWEEN 0 AND 1 AND (region->>'y')::numeric BETWEEN 0 AND 1
    AND (region->>'w')::numeric > 0 AND (region->>'h')::numeric > 0
    AND (region->>'x')::numeric + (region->>'w')::numeric <= 1.0001
    AND (region->>'y')::numeric + (region->>'h')::numeric <= 1.0001));
REVOKE DELETE, TRUNCATE ON annotations FROM ksp_app;
-- one owner row per workspace (the OWNER member row mirrors workspaces.owner_id)
CREATE UNIQUE INDEX workspace_members_one_owner ON workspace_members (workspace_id) WHERE role = 'OWNER';
