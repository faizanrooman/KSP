-- MFA challenge follows the administrator's policy (Settings → Sessions & MFA → "MFA mandatory for roles").
-- Sign-in asks for the authenticator code when MFA is mandatory for one of the user's roles, or when the user turned
-- two-step sign-in on themselves (My profile) while no role required it. An enrolment that exists only because a role
-- used to be on the mandatory list is kept (so the code works again at once if the role is re-added) but is no longer
-- challenged after the administrator removes that role from the list.
-- Existing enrolments start as policy-driven (false): every user enrolled before this migration was asked to enrol by
-- the role policy or chose to; the latter can turn it on again from My profile.
ALTER TABLE users ADD COLUMN mfa_self_enrolled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN users.mfa_self_enrolled IS 'true = the user enabled MFA while none of their roles required it; challenged at sign-in regardless of the role policy';
