Pi Coding Agent pure compaction extraction

Source: pi-coding-agent at upstream commit 636703a0a4f2f4d8558d08f2308cb41109585bf5.
Read in full: packages/coding-agent/src/core/compaction/compaction.ts, packages/coding-agent/src/core/compaction/utils.ts, packages/coding-agent/src/core/session-manager.ts projection, packages/coding-agent/src/core/messages.ts.

This is an adapted linear projection over chronological transcript seq rows. It is not the upstream tree walk, leaf path, branch summary, or context_edit replacement machinery.

Copied pure functions and adaptations (no fs, session-manager runtime, or TUI imports):

- cut.ts estimateCutTokens from compaction.ts estimateTokens. Keeps chars-per-4 plus 4800 chars per image, system sections and tool deltas, assistant thinking and toolCall name plus arguments. Uses pi-ai Message types already vendored at 1.0.2.
- cut.ts isCutPointMessage and isTurnStartMessage from compaction.ts. Product transcripts store only user, assistant, and toolResult, so system is never a cut or turn start, user starts a turn, assistant is a cut point, toolResult is never a cut point. Upstream bashExecution, custom, branchSummary, and compactionSummary roles have no product equivalent and were omitted.
- cut.ts findValidCutPoints, findTurnStartIndex, and findCutPoint from compaction.ts findValidCutPoints, findTurnStartIndex, and findCutPoint. Operates on linear TranscriptEntry rows in chronological seq order instead of SessionEntry trees. Walks back from newest accumulating estimateCutTokens, cuts at the closest valid assistant or user boundary at or after the budget, and reports split-turn state with turnStartIndex. Never cuts at toolResult. Metadata-only rows are skipped for budgeting as in upstream.
- serialize.ts truncateForSummary, TOOL_RESULT_MAX_CHARS, and serializeConversation from utils.ts. Keeps the 2000-char tool-result cap and the User, Assistant thinking, Assistant, Assistant tool calls, and Tool result labels. Adds explicit image markers for user and toolResult image blocks because pi-ai contentText drops non-text blocks. Skips system messages because the current system prompt is rebuilt separately.
- serialize.ts renderTranscriptEntries adapts serializeConversation to TranscriptEntry rows with lenient parseMessage validation, replacing the hand-written renderEntry join.
- projection.ts summaryMessage keeps the product untrusted framing with Earlier conversation summary plus untrusted tags. This replaces upstream COMPACTION_SUMMARY_PREFIX and SUFFIX framing, which is recorded here and not copied, so the durable transcript and summary stay framed as untrusted data.
- projection.ts buildProjectedMessages is a chronological linear projection only: current system prompt first, then at most one folded summary, then kept transcript rows in seq order. It parses each kept row strictly and throws on malformed persisted rows, matching the former adapter behavior. The system object is used verbatim so it stays current. There is no leaf walk, branch handling, context_edit replacement, or parallel session persistence.
- projection.ts buildSummaryRequestMessage adapts compaction.ts generateSummary prompt building. It keeps the product SUMMARY_INSTRUCTION handoff text, folds a prior summary exactly once when present, and serializes older turns with the adapted serializeConversation. The upstream structured Goal, Constraints, Progress, Decisions, Next Steps, Critical Context format and turn-prefix sub-summary were not copied; split-turn intent is preserved because older rows include the turn start and kept rows resume at a complete assistant boundary.
- index.ts re-exports the extraction contract only. No upstream runtime, LLM call, retry, file-operation tracking, or branch-summary code was copied.

What was deliberately not copied:

- No generateSummary, completeSummarization, compact, prepareCompaction LLM calls, retry policy, or streaming code.
- No extractFileOpsFromMessage, computeFileLists, formatFileOperations, read or write tracking.
- No buildSessionPath, buildContextEntries tree walk, context_edit replacement, branch summaries, or session file IO.
- No convertToLlm custom-type transformer beyond the roles already in pi-ai Message. No TUI or host tool code.
- No dependency changes. Uses existing pi-ai 1.0.2 types and utils plus product parseMessage validation.

Upstream license, exact text:

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
