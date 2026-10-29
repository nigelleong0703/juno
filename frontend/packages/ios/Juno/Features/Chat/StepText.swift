import Foundation

/// A step in words. The agent's tools come through as `verb: "Executed", target: "<tool name>"` (web reads as
/// `Read <host>` / `Looked up <query>`); this turns them into one sentence a person can read and hides the
/// plumbing.
///
/// Returns nil for steps not worth showing: the ones the backend marks `internal`.
func stepLine(_ step: Step, in run: [Step] = []) -> (text: String, domain: String?)? {
    let tool = StepText.tool(step)
    // The backend marks plumbing steps `internal` (finding tools and skills, the agent's own bookkeeping, reading back what it saw);
    // the app keeps no list of tool names.
    if step.internal == true { return nil }
    let args = StepText.args(step)
    let out = step.output?.summary ?? step.output?.text ?? ""
    // File and shell calls say which computer they ran on when it was the owner's Mac; the sandbox keeps today's wording.
    let onMac = (args["on"] as? String) == "mac" ? " on your Mac" : ""

    if StepText.isRefusedPurchase(step) { return ("Waiting for your approval to place the order", nil) }

    switch tool {
    case "web_search":
        let q = (args["query"] as? String) ?? step.target ?? ""
        return ("Searched for \u{201C}\(StepText.clip(q, 60))\u{201D}", nil)
    case "web_fetch", "browser.navigate", "browser.new_tab":
        let url = (args["url"] as? String) ?? step.input?.url ?? ""
        if let q = StepText.searchQuery(url) { return ("Searched for \u{201C}\(StepText.clip(q, 60))\u{201D}", StepText.host(url)) }
        let host = StepText.host(url) ?? (step.verb == "Read" ? step.target : nil)
        let title = StepText.title(out)
        let page = title ?? host ?? "a page"
        // A fetch only reads the page's text; "Opened" would suggest the agent's browser, which the user can watch.
        if tool == "web_fetch" { return ("Read \(page)", title == nil ? nil : host) }
        return ("Opened \(page) in the browser", title == nil ? nil : host)
    case "browser.click":
        let ref = args["ref"] as? String
        let label = StepText.clickedLabel(out) ?? StepText.refLabel(ref, in: out)
            ?? run.reversed().first { ($0.index ?? 0) < (step.index ?? 0) && StepText.refLabel(ref, in: $0.output?.summary ?? "") != nil }
                .flatMap { StepText.refLabel(ref, in: $0.output?.summary ?? "") }
        return (label.map { "Clicked \(StepText.clip($0, 50))" } ?? "Clicked on the page", nil)
    case "computer.click", "computer.double_click", "computer.right_click":
        return (StepText.clickedLabel(out).map { "Clicked \(StepText.clip($0, 50))" } ?? "Clicked on the page", nil)
    case "browser.type", "computer.type":
        let text = (args["text"] as? String) ?? ""
        return (text.isEmpty ? "Typed some text" : "Typed \u{201C}\(StepText.clip(text, 40))\u{201D}", nil)
    case "browser.fill":
        let n = (args["fields"] as? [Any])?.count ?? 0
        return (n > 1 ? "Filled in \(n) fields" : "Filled in a field", nil)
    case "computer.scroll":
        return ("Scrolled the page", nil)
    case "computer.key":
        return ("Pressed \((args["key"] as? String) ?? "a key")", nil)
    case "browser.tabs":
        return ("Checked the open tabs", nil)
    case "browser.dialog":
        return ("Answered a page dialog", nil)
    case "child_spawn":
        let what = (step.verb == "Asked a helper" ? step.target : nil) ?? (args["title"] as? String) ?? (args["prompt"] as? String) ?? ""
        return (what.isEmpty ? "Asked a helper for a hand" : "Asked a helper to \(StepText.clip(what, 60))", nil)
    case "request_secure_input":
        let labels = ((args["fields"] as? [[String: Any]]) ?? []).compactMap { $0["label"] as? String }
        return (labels.isEmpty ? "Asked you for details" : "Asked you for \(labels.joined(separator: ", "))", nil)
    case "request_takeover":
        return ("Asked you to take over the screen", nil)
    case "shell.run", "shell.start":
        let cmd = (args["command"] as? String) ?? step.input?.command ?? ""
        return ((cmd.isEmpty ? "Ran a command" : "Ran \(StepText.clip(cmd, 40))") + onMac, nil)
    case "files.read", "files.write", "files.edit":
        let name = ((args["path"] as? String) ?? "").split(separator: "/").last.map(String.init)
        let verb = tool == "files.read" ? "Read" : tool == "files.write" ? "Wrote" : "Edited"
        return ((name.map { "\(verb) \($0)" } ?? "\(verb) a file") + onMac, nil)
    case "computer_copy":
        let name = ((args["path"] as? String) ?? (args["toPath"] as? String) ?? "").split(separator: "/").last.map(String.init) ?? "a file"
        func side(_ key: String) -> String { (args[key] as? String) == "mac" ? "your Mac" : "the sandbox" }
        return ("Copied \(name) from \(side("from")) to \(side("to"))", nil)
    default:
        return (StepText.humanize(tool), nil)
    }
}

/// The SF Symbol for a step row (nil = use the status icon).
func stepSymbol(_ step: Step) -> String? {
    if StepText.isRefusedPurchase(step) { return "hourglass" }
    switch StepText.tool(step) {
    case "web_search": return "magnifyingglass"
    case "web_fetch", "browser.navigate", "browser.new_tab", "browser.tabs": return StepText.searchQuery(step.input?.url ?? (StepText.args(step)["url"] as? String) ?? "") != nil ? "magnifyingglass" : "globe"
    case "browser.click", "computer.click", "computer.double_click", "computer.right_click": return "cursorarrow"
    case "browser.type", "browser.fill", "computer.type", "computer.key": return "keyboard"
    case "computer.scroll": return "arrow.up.and.down"
    case "shell.run", "shell.start": return "terminal"
    case "request_secure_input": return "lock"
    default: return nil
    }
}

/// The steps worth a row, in order.
/// The steps that get a row. A step that reads the same as the one before (a page read then opened, three
/// clicks with no label) shows once.
func visibleSteps(_ steps: [Step]) -> [Step] {
    var shown: [Step] = []
    var last: String?
    for step in steps {
        guard let line = stepLine(step, in: steps) else { continue }
        if line.text == last { continue }
        last = line.text
        shown.append(step)
    }
    return shown
}

/// A short readable excerpt of what the tool returned: page snapshots, refs and fetch boilerplate stripped.
func stepExcerpt(_ step: Step) -> String? {
    guard !StepText.isRefusedPurchase(step), let raw = step.output?.summary ?? step.output?.text else { return nil }
    let noise = ["Snapshot of tab", "(Fetched as text", "(Untrusted", "Page content below", "[image]", "Captured screen", "Title:", "URL:"]
    let lines = raw.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { line in
        !line.isEmpty && line.range(of: #"^[-#\s]*e\d+ \["#, options: .regularExpression) == nil
            && !line.hasPrefix("## ") && !noise.contains { line.hasPrefix($0) }
            && !line.hasPrefix("Navigated tab") && !line.hasPrefix("Clicked ")
    }
    let text = lines.joined(separator: " ").replacingOccurrences(of: "...[truncated]", with: "")
    return text.isEmpty ? nil : StepText.clip(text, 280)
}

/// A task's progress line. The server writes the newest step as "<verb> <target>" ("Executed browser.click"); this says
/// it in the step list's words, never the raw tool name. Lines that are already words pass through.
func progressText(_ progress: String) -> String {
    let parts = progress.trimmingCharacters(in: .whitespaces).split(separator: " ", maxSplits: 1).map(String.init)
    guard parts.count == 2, parts[0] == "Executed", !parts[1].contains(" ") else { return progress }
    var step = Step(id: "progress")
    step.verb = "Executed"
    step.target = parts[1]
    guard let line = stepLine(step)?.text else { return "Working…" }
    let first = line.split(separator: " ", maxSplits: 1).first.map(String.init) ?? ""
    guard let ing = progressiveVerbs[first] else { return line }
    return ing + line.dropFirst(first.count)
}

private let progressiveVerbs = ["Clicked": "Clicking", "Opened": "Opening", "Searched": "Searching", "Typed": "Typing", "Filled": "Filling",
                                "Scrolled": "Scrolling", "Pressed": "Pressing", "Ran": "Running", "Read": "Reading", "Wrote": "Writing",
                                "Edited": "Editing", "Copied": "Copying", "Checked": "Checking", "Answered": "Answering", "Asked": "Asking", "Looked": "Looking"]

enum StepText {
    /// The backend names what was clicked: `Clicked "512 GB" (e681) on tab t1 (…)` / `Clicked "Buy now" at (x, y)`.
    static func clickedLabel(_ output: String) -> String? {
        guard output.hasPrefix("Clicked \""), let end = output.dropFirst(9).firstIndex(of: "\"") else { return nil }
        let label = String(output[output.index(output.startIndex, offsetBy: 9)..<end])
        return label.isEmpty ? nil : label
    }

    /// `Executed browser.click` -> "browser.click"; `Read host` -> "web_fetch"; `Looked up q` -> "web_search".
    static func tool(_ step: Step) -> String {
        switch step.verb {
        case "Read": "web_fetch"
        case "Looked up": "web_search"
        case "Asked a helper": "child_spawn"
        default: step.target ?? ""
        }
    }

    static func args(_ step: Step) -> [String: Any] {
        guard let data = step.input?.summary?.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            var fallback: [String: Any] = [:]
            if let url = step.input?.url { fallback["url"] = url }
            if let text = step.input?.text { fallback["text"] = text }
            return fallback
        }
        return obj
    }

    /// "Not clicked: ..." is the purchase gate asking for approval, not a failure.
    static func isRefusedPurchase(_ step: Step) -> Bool {
        step.status == "failed" && (step.output?.summary ?? step.output?.text ?? "").hasPrefix("Not clicked:")
    }

    static func clip(_ s: String, _ n: Int) -> String {
        let one = s.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        return one.count > n ? String(one.prefix(n)).trimmingCharacters(in: .whitespaces) + "\u{2026}" : one
    }

    static func host(_ url: String) -> String? {
        guard let h = URL(string: url)?.host else { return nil }
        return h.hasPrefix("www.") ? String(h.dropFirst(4)) : h
    }

    /// The `q` of a bing / google / duckduckgo results page.
    static func searchQuery(_ url: String) -> String? {
        guard let comps = URLComponents(string: url), let host = comps.host,
              ["bing.", "google.", "duckduckgo."].contains(where: host.contains), comps.path.hasPrefix("/search") || host.contains("duckduckgo"),
              let q = comps.queryItems?.first(where: { $0.name == "q" })?.value, !q.isEmpty else { return nil }
        return q.replacingOccurrences(of: "+", with: " ")
    }

    /// The page a step touched: the tool's `url` argument, else the `URL:` line of a web read.
    static func url(_ step: Step) -> String? {
        if let u = args(step)["url"] as? String { return u }
        guard let out = step.output?.summary else { return nil }
        return out.split(separator: "\n").first { $0.hasPrefix("URL: ") }.map { String($0.dropFirst(5)) }
    }

    /// "Title: x" (web reads) or "Navigated tab t1 to x (url)".
    static func title(_ out: String) -> String? {
        let first = out.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? ""
        var t: String?
        if first.hasPrefix("Title:") { t = String(first.dropFirst(6)) }
        else if first.hasPrefix("Navigated tab"), let r = first.range(of: #" to "#), let end = first.range(of: " (http", options: .backwards) {
            t = String(first[r.upperBound..<end.lowerBound])
        }
        let clean = t?.trimmingCharacters(in: .whitespaces)
        return clean?.isEmpty == false ? clip(clean!, 80) : nil
    }

    /// The accessible name of `ref` from a "- e12 [button] Add to cart" line in the tool output.
    static func refLabel(_ ref: String?, in out: String) -> String? {
        guard let ref, let r = out.range(of: "- \(ref) [") else { return nil }
        let line = out[r.upperBound...].prefix { $0 != "\n" }
        guard let close = line.firstIndex(of: "]") else { return nil }
        let label = line[line.index(after: close)...].trimmingCharacters(in: .whitespaces)
        return label.isEmpty ? nil : label
    }

    /// "github_create_issue" / "browser.foo" -> "Github create issue".
    static func humanize(_ tool: String) -> String {
        let words = tool.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: ".", with: " ").replacingOccurrences(of: "-", with: " ")
        guard let first = words.first else { return "Did something" }
        return first.uppercased() + words.dropFirst()
    }
}
