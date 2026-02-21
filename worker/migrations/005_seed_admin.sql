-- Seed initial super admin user
-- Replace the email below with the actual Cloudflare Access email of the first admin
INSERT OR IGNORE INTO admin_users (email, role, is_active) VALUES
  ('teiteipara@gmail.com', 'super_admin', 1);
