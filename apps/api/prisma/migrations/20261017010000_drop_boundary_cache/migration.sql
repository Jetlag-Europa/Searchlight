-- BoundaryCache only cached OSM boundaries for the /boundaries route, which
-- is removed along with free play. IF EXISTS: an earlier version of this
-- migration ran on some dev and preview databases under another name.

-- DropTable
DROP TABLE IF EXISTS "BoundaryCache";
