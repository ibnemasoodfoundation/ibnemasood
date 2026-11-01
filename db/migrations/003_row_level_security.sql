-- 003: Row Level Security.
-- The portal reads and writes only from its own server, connecting as the table owner,
-- which RLS does not restrict. Enabling RLS with no policies therefore leaves the app
-- working while denying every other database role. On Supabase this closes all tables
-- to the public REST API and the anon / authenticated keys, so names, phone numbers
-- and password hashes cannot be read from a browser.
ALTER TABLE users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE admissions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE donations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity      ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches      ENABLE ROW LEVEL SECURITY;
ALTER TABLE makatib       ENABLE ROW LEVEL SECURITY;
ALTER TABLE teachers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE students      ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfers     ENABLE ROW LEVEL SECURITY;
