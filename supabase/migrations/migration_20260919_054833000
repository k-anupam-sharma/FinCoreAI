CREATE TABLE query_logs (
  query_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  user_question TEXT NOT NULL,
  query_type TEXT NOT NULL CHECK (query_type IN ('snapshot', 'safe_query', 'keyword')),
  tables_accessed TEXT[] NOT NULL,
  execution_status TEXT NOT NULL CHECK (execution_status IN ('success', 'failed', 'timeout', 'blocked')),
  rows_returned INTEGER DEFAULT 0,
  error_message TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE query_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "backend-only query logs" ON query_logs
  FOR ALL USING (false) WITH CHECK (false);