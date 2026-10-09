-- v103 — the chat assistant's memory, which lasts 24 hours and no longer.
--
-- The operator (2026-10-09): "for now anyone, and remove all memory every 24
-- hours, including generated files". So nothing here is a record: a
-- conversation, every message in it, and every result it fetched are deleted
-- 24 hours after they were written, by api/agent_routes.js on the hour and at
-- the start of every chat turn. Excel files are never written anywhere — each
-- download is built from its stored results at the moment it is asked for —
-- so deleting the results is what deletes the file; its link stops working
-- the same instant.
--
-- `owner` is who may read a conversation: 'u:<user id>' for a signed-in
-- person, 'd:<device id>' for a device, 'a:<random cookie>' for a visitor
-- while sign-in is optional. Every read and every download checks it; a
-- conversation id on its own opens nothing.
--
-- No text from these tables is ever written to a log (api/agent_routes.js
-- logs counts, tool names and timings only), so nothing outlives the sweep in
-- the platform's log store either.
CREATE TABLE IF NOT EXISTS agent_conversation (
  id          text PRIMARY KEY,
  owner       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_at     timestamptz NOT NULL DEFAULT now(),
  context     jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_result int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS agent_conversation_owner_idx ON agent_conversation (owner, last_at DESC);
CREATE INDEX IF NOT EXISTS agent_conversation_created_idx ON agent_conversation (created_at);

CREATE TABLE IF NOT EXISTS agent_message (
  id              bigserial PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  body            jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_message_conv_idx ON agent_message (conversation_id, id);
CREATE INDEX IF NOT EXISTS agent_message_created_idx ON agent_message (created_at);

CREATE TABLE IF NOT EXISTS agent_result (
  conversation_id text NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
  rid             text NOT NULL,
  body            jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, rid)
);
CREATE INDEX IF NOT EXISTS agent_result_created_idx ON agent_result (created_at);
