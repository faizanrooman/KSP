-- 0100: database-level guards for identity & administration (defence in depth behind the API rules).
--
--  * Org units cannot be re-parented or re-coded: evidence.org_path (and other org_path columns) are
--    denormalised copies of org_units.path used for jurisdiction checks, so changing a path would silently
--    move evidence between jurisdictions. Create a new unit and deactivate the old one instead.
--  * System roles cannot be deleted and no role can change its code or system flag (role codes are referenced
--    by settings such as sessionPolicy.requireMfaForRoles and by the audit trail).
--  * Device serial numbers are unique case-insensitively.
-- Violations raise insufficient_privilege (42501), which the API maps to 409 IMMUTABLE.

CREATE OR REPLACE FUNCTION org_units_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.path IS DISTINCT FROM OLD.path OR NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'org unit code, parent and path are immutable (re-parenting is not supported)' USING ERRCODE = '42501';
  END IF;
  IF NEW.unit_type IS DISTINCT FROM OLD.unit_type THEN
    RAISE EXCEPTION 'org unit type is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER org_units_guard BEFORE UPDATE ON org_units FOR EACH ROW EXECUTE FUNCTION org_units_guard();

CREATE OR REPLACE FUNCTION org_units_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'org units cannot be deleted; deactivate them instead' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER org_units_no_delete BEFORE DELETE ON org_units FOR EACH ROW EXECUTE FUNCTION org_units_no_delete();

CREATE OR REPLACE FUNCTION roles_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system THEN
      RAISE EXCEPTION 'system roles cannot be deleted' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.code IS DISTINCT FROM OLD.code OR NEW.is_system IS DISTINCT FROM OLD.is_system THEN
    RAISE EXCEPTION 'role code and system flag are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER roles_guard BEFORE UPDATE OR DELETE ON roles FOR EACH ROW EXECUTE FUNCTION roles_guard();

CREATE UNIQUE INDEX devices_serial_ci ON devices (upper(serial_number));

-- Role assignments: an expiry must lie after the grant.
ALTER TABLE user_roles ADD CONSTRAINT user_roles_expiry_after_grant CHECK (expires_at IS NULL OR expires_at > granted_at);

-- Per-resource audit history lookups (device/user/role/org unit history panes).
CREATE INDEX audit_events_resource ON audit_events (resource_type, resource_id, seq DESC) WHERE resource_id IS NOT NULL;
