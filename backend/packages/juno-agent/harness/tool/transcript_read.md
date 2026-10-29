---
id: tool.transcript_read
placement: T
vars: []
---
Read earlier messages of the current conversation: seq-ordered user, assistant and tool-result turns. Hidden model thinking and signatures are omitted. Defaults to the current session (the wake sessionKey). range { from, to } pages 0-based positions: from inclusive, to exclusive, default 0..50, max 200 per call. The response reports total/hasMore/nextFrom so callers can page without loss. around (ISO date or datetime) instead pages a window of about 40 entries centred on that time, e.g. a transcript_search hit. Passing any other sessionKey is rejected. In a room conversation this returns the shared visible room messages (newest bounded window by default) instead of per-agent turns.
