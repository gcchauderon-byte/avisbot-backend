-- AVISBOT DATABASE SCHEMA
-- À coller dans Supabase → SQL Editor → Run

CREATE TABLE clients (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  stripe_customer_id TEXT,
  plan TEXT DEFAULT 'Starter',
  status TEXT DEFAULT 'onboarding', -- onboarding | active | paused | cancelled
  restaurant_name TEXT,
  google_location_id TEXT,
  google_access_token TEXT,
  google_refresh_token TEXT,
  google_token_expiry BIGINT,
  tone TEXT DEFAULT 'professionnel et chaleureux',
  manager_name TEXT,
  reviews_answered INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE review_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID REFERENCES clients(id),
  review_id TEXT NOT NULL,
  star_rating INTEGER,
  review_text TEXT,
  response_text TEXT,
  published_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT DEFAULT 'published' -- published | error | skipped
);

-- Index pour performance
CREATE INDEX idx_clients_status ON clients(status);
CREATE INDEX idx_clients_email ON clients(email);
CREATE INDEX idx_review_log_client ON review_log(client_id);
