-- 0046: the chat an account was last seen in (BACKEND §5.3, batch 5b follow-up). person_link lists a platform's accounts by name and,
-- when several match, tells the owner which chat each one spoke in. Empty when no chat was recorded (rows written before this migration).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_chat text NOT NULL DEFAULT '';
