import Foundation

extension World {
    /// A top-level task that ended badly and left no reply: the one run that gets its own row in the transcript.
    static func isFailedRunRow(_ run: Run?) -> Bool {
        guard let run, run.parentRunId == nil else { return false }
        return run.status == "failed" || run.status == "stopped"
    }

    /// The message that started a run: the user's message right before it.
    func triggerMessage(of run: Run) -> Item? {
        guard let conversationId = run.conversationId, let start = run.startedAt else { return nil }
        return items[conversationId]?.last { $0.type == "user_message" && ($0.at ?? .distantFuture) <= start.addingTimeInterval(2) }
    }

    /// The Activity sheet's title: the run's own title, else the first line of the message that started it. Never the
    /// generic "Task" (a run the backend has not titled yet carries that placeholder).
    static func taskTitle(runTitle: String?, trigger: String?) -> String? {
        func firstLine(_ text: String?) -> String? {
            let line = text?.split(whereSeparator: \.isNewline).first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
            return line.isEmpty ? nil : line
        }
        if let own = firstLine(runTitle), own.caseInsensitiveCompare("Task") != .orderedSame { return own }
        guard let line = firstLine(trigger) else { return nil }
        return line.count > 60 ? String(line.prefix(60)).trimmingCharacters(in: .whitespaces) + "\u{2026}" : line
    }

    func taskTitle(for run: Run?) -> String? {
        World.taskTitle(runTitle: run?.title, trigger: run.flatMap(triggerMessage(of:))?.text)
    }

    /// "Retry" on a failed task: send the message that triggered it again. Without it, the steps sheet opens instead.
    func retryRun(_ run: Run) {
        guard let conversationId = run.conversationId, let trigger = triggerMessage(of: run), let text = trigger.text, !text.isEmpty else {
            sheet = .runSteps(run.id)
            return
        }
        send(text, in: conversationId, files: trigger.attachments ?? [], mentions: trigger.mentions ?? [])
    }
}

extension World {
    /// Actually on a task now: a top-level run that is running or queued. Blocked / waiting-for-input runs
    /// are not "working" (one left blocked since yesterday showed as working).
    func isWorking(_ agentId: String) -> Bool {
        runs.contains { $0.agentId == agentId && $0.parentRunId == nil && ["running", "queued"].contains($0.status ?? "") }
    }
}
