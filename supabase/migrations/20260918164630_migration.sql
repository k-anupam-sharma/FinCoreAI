CREATE TABLE whatsapp_message_receipts (
  wa_message_id text PRIMARY KEY,
  wa_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE whatsapp_message_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "backend-only message receipts" ON whatsapp_message_receipts
  FOR ALL USING (false) WITH CHECK (false);