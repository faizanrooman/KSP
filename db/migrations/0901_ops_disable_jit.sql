-- 0901: disable PostgreSQL JIT for this database.
-- Jurisdiction filters (ltree <@ ANY(array) OR hashed EXISTS sub-plans) inflate planner cost estimates past
-- jit_above_cost, so ordinary OLTP/dashboard queries paid 300-400 ms of LLVM compilation for ~30 ms of work
-- (measured on 50k evidence rows: 454 ms with JIT vs 31 ms without). JIT only helps long analytical scans.
-- Takes effect for new connections.
DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET jit = off', current_database()); END $$;
