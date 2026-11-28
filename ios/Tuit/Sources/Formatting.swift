import Foundation
import SwiftUI

enum Household {
    /// Calendar dates from the server are days in the household's zone, not the phone's. Set
    /// from /api/me; Sydney until then (the server's default).
    static var zone = TimeZone(identifier: "Australia/Sydney")!
}

enum Fmt {
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoPlain = ISO8601DateFormatter()

    static func date(_ s: String) -> Date? {
        iso.date(from: s) ?? isoPlain.date(from: s)
    }

    static func ago(_ s: String) -> String {
        guard let d = date(s) else { return s }
        let r = RelativeDateTimeFormatter()
        r.unitsStyle = .full
        return r.localizedString(for: d, relativeTo: .now)
    }

    static func when(_ s: String) -> String {
        guard let d = date(s) else { return s }
        return d.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute())
    }

    static func moment(_ m: Moment) -> String {
        switch m {
        case .at(let a): return when(a)
        case .date(let d):
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd"
            f.timeZone = Household.zone
            guard let day = f.date(from: d) else { return d }
            var cal = Calendar(identifier: .gregorian)
            cal.timeZone = Household.zone
            if cal.isDateInToday(day) { return "today" }
            if cal.isDateInTomorrow(day) { return "tomorrow" }
            if cal.isDateInYesterday(day) { return "yesterday" }
            let out = DateFormatter()
            out.timeZone = Household.zone
            out.setLocalizedDateFormatFromTemplate(cal.isDate(day, equalTo: .now, toGranularity: .year) ? "EEE d MMM" : "d MMM yyyy")
            return out.string(from: day)
        }
    }

    /// The text form of a moment for an edit field; the server parses it back.
    static func input(_ m: Moment?) -> String {
        switch m {
        case .none: ""
        case .date(let d): d
        case .at(let a):
            date(a).map {
                let f = DateFormatter()
                f.timeZone = Household.zone
                f.dateFormat = "yyyy-MM-dd HH:mm"
                return f.string(from: $0)
            } ?? a
        }
    }

    /// A day as the API's date string, in the household's zone.
    static func day(_ d: Date) -> String {
        let f = DateFormatter()
        f.timeZone = Household.zone
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }

    /// Inline Markdown parser (preserves single newlines as line breaks, matching the web view).
    static func inlineMarkdown(_ s: String) -> AttributedString {
        let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: s, options: opts)) ?? AttributedString(s)
    }

    /// Brief and notes are GitHub-flavoured Markdown. Kept for callers that need a single
    /// AttributedString; prefer `MarkdownView` for block rendering.
    static func markdown(_ s: String) -> AttributedString {
        let cleaned = s
            .replacingOccurrences(of: "<details>", with: "")
            .replacingOccurrences(of: "</details>", with: "")
            .replacingOccurrences(of: "<summary>", with: "**")
            .replacingOccurrences(of: "</summary>", with: "**")
            // Inline parsing leaves list markers as typed; show them as bullets.
            .replacingOccurrences(of: #"(?m)^(\s*)[-*] "#, with: "$1• ", options: .regularExpression)
        return inlineMarkdown(cleaned)
    }
}

enum MarkdownListMarker: Equatable, Sendable {
    case bullet
    case ordered(String)
    case task(done: Bool)
}

struct MarkdownListItem: Equatable, Sendable {
    let indent: Int
    let marker: MarkdownListMarker
    let text: String
}

enum MarkdownBlock: Equatable, Sendable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case list([MarkdownListItem])
    case codeBlock(String)
    case blockquote(String)
    case table(headers: [String], rows: [[String]])
    case details(summary: String, body: [MarkdownBlock])
    case divider
}

enum MarkdownParser {
    static func parse(_ input: String) -> [MarkdownBlock] {
        let normalized = input.replacingOccurrences(of: "\r\n", with: "\n")
        let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        return parseLines(lines)
    }

    private static func parseLines(_ lines: [String]) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                i += 1
                continue
            }

            if isDetailsOpen(trimmed) {
                let (block, next) = parseDetails(lines, from: i)
                blocks.append(block)
                i = next
                continue
            }

            if let fence = fencePrefix(trimmed) {
                var codeLines: [String] = []
                i += 1
                while i < lines.count {
                    let candidate = lines[i].trimmingCharacters(in: .whitespaces)
                    if candidate.hasPrefix(fence), candidate.allSatisfy({ $0 == fence.first }) {
                        i += 1
                        break
                    }
                    codeLines.append(lines[i])
                    i += 1
                }
                blocks.append(.codeBlock(codeLines.joined(separator: "\n")))
                continue
            }

            if isDivider(trimmed) {
                blocks.append(.divider)
                i += 1
                continue
            }

            if let (level, text) = parseHeading(trimmed) {
                blocks.append(.heading(level: level, text: text))
                i += 1
                continue
            }

            if isBlockquote(line) {
                var quoteLines: [String] = []
                while i < lines.count, let content = stripBlockquote(lines[i]) {
                    quoteLines.append(content)
                    i += 1
                }
                blocks.append(.blockquote(quoteLines.joined(separator: "\n")))
                continue
            }

            if i + 1 < lines.count, isTableHeader(line, separator: lines[i + 1]) {
                let headers = splitTableRow(line)
                i += 2
                var rows: [[String]] = []
                while i < lines.count {
                    let rowLine = lines[i]
                    let rowTrimmed = rowLine.trimmingCharacters(in: .whitespaces)
                    if rowTrimmed.isEmpty || !rowTrimmed.contains("|") { break }
                    rows.append(splitTableRow(rowLine))
                    i += 1
                }
                blocks.append(.table(headers: headers, rows: rows))
                continue
            }

            if parseListItem(line) != nil {
                var items: [MarkdownListItem] = []
                while i < lines.count {
                    if let item = parseListItem(lines[i]) {
                        items.append(item)
                        i += 1
                    } else if !items.isEmpty,
                              lines[i].hasPrefix("  ") || lines[i].hasPrefix("\t"),
                              !lines[i].trimmingCharacters(in: .whitespaces).isEmpty,
                              !isBlockBoundary(lines, at: i) {
                        let prev = items.removeLast()
                        let cont = lines[i].trimmingCharacters(in: .whitespaces)
                        items.append(MarkdownListItem(indent: prev.indent, marker: prev.marker, text: prev.text + "\n" + cont))
                        i += 1
                    } else {
                        break
                    }
                }
                blocks.append(.list(items))
                continue
            }

            var paraLines: [String] = []
            while i < lines.count {
                let cur = lines[i]
                if cur.trimmingCharacters(in: .whitespaces).isEmpty { break }
                if !paraLines.isEmpty && isBlockBoundary(lines, at: i) { break }
                paraLines.append(cur)
                i += 1
            }
            if !paraLines.isEmpty {
                blocks.append(.paragraph(paraLines.joined(separator: "\n")))
            }
        }
        return blocks
    }

    private static func isBlockBoundary(_ lines: [String], at i: Int) -> Bool {
        let line = lines[i]
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if isDetailsOpen(trimmed) || fencePrefix(trimmed) != nil || isDivider(trimmed) { return true }
        if parseHeading(trimmed) != nil || isBlockquote(line) || parseListItem(line) != nil { return true }
        if i + 1 < lines.count && isTableHeader(line, separator: lines[i + 1]) { return true }
        return false
    }

    private static func isDetailsOpen(_ trimmed: String) -> Bool {
        let lower = trimmed.lowercased()
        return lower == "<details>" || lower.hasPrefix("<details ")
    }

    private static func parseDetails(_ lines: [String], from start: Int) -> (MarkdownBlock, Int) {
        var i = start + 1
        var inner: [String] = []
        var depth = 1
        while i < lines.count {
            let trimmed = lines[i].trimmingCharacters(in: .whitespaces)
            let lower = trimmed.lowercased()
            if isDetailsOpen(trimmed) {
                depth += 1
                inner.append(lines[i])
            } else if lower == "</details>" {
                depth -= 1
                if depth == 0 {
                    i += 1
                    break
                }
                inner.append(lines[i])
            } else {
                inner.append(lines[i])
            }
            i += 1
        }
        let rawInner = inner.joined(separator: "\n")
        var summary = "Details"
        var bodyText = rawInner
        if let range = rawInner.range(of: #"(?is)<summary>(.*?)</summary>"#, options: .regularExpression) {
            let matched = String(rawInner[range])
            let stripped = matched
                .replacingOccurrences(of: #"(?i)^<summary>"#, with: "", options: .regularExpression)
                .replacingOccurrences(of: #"(?i)</summary>$"#, with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !stripped.isEmpty { summary = stripped }
            bodyText = rawInner.replacingCharacters(in: range, with: "")
        }
        return (.details(summary: summary, body: parse(bodyText)), i)
    }

    private static func fencePrefix(_ trimmed: String) -> String? {
        for ch in ["`", "~"] {
            let prefix = String(repeating: ch, count: 3)
            if trimmed.hasPrefix(prefix) {
                let count = trimmed.prefix(while: { String($0) == ch }).count
                return String(repeating: ch, count: count)
            }
        }
        return nil
    }

    private static func isDivider(_ trimmed: String) -> Bool {
        let compact = trimmed.filter { !$0.isWhitespace }
        guard compact.count >= 3, let first = compact.first, "-*_".contains(first) else { return false }
        return compact.allSatisfy { $0 == first }
    }

    private static func parseHeading(_ trimmed: String) -> (Int, String)? {
        let hashes = trimmed.prefix(while: { $0 == "#" })
        guard (1...6).contains(hashes.count) else { return nil }
        let rest = trimmed.dropFirst(hashes.count)
        guard rest.first == " " else { return nil }
        let text = rest.dropFirst().trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : (hashes.count, text)
    }

    private static func isBlockquote(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespaces).hasPrefix(">")
    }

    private static func stripBlockquote(_ line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix(">") else { return nil }
        let after = trimmed.dropFirst()
        return after.first == " " ? String(after.dropFirst()) : String(after)
    }

    private static func parseListItem(_ line: String) -> MarkdownListItem? {
        let leadingSpaces = line.prefix(while: { $0 == " " || $0 == "\t" })
        let spaceCount = leadingSpaces.reduce(0) { $0 + ($1 == "\t" ? 2 : 1) }
        let indent = min(spaceCount / 2, 4)
        let rest = String(line.dropFirst(leadingSpaces.count))

        if rest.count >= 6,
           let first = rest.first, "-*+".contains(first),
           rest.dropFirst().hasPrefix(" [") {
            let afterBracket = rest.dropFirst(3)
            if let state = afterBracket.first, " xX".contains(state),
               afterBracket.dropFirst().hasPrefix("] ") {
                let text = String(afterBracket.dropFirst(3))
                return MarkdownListItem(indent: indent, marker: .task(done: state != " "), text: text)
            }
        }

        if rest.count >= 2, let first = rest.first, "-*+".contains(first), rest.dropFirst().first == " " {
            return MarkdownListItem(indent: indent, marker: .bullet, text: String(rest.dropFirst(2)))
        }

        let digits = rest.prefix(while: \.isNumber)
        if !digits.isEmpty {
            let afterDigits = rest.dropFirst(digits.count)
            if afterDigits.hasPrefix(". ") {
                return MarkdownListItem(
                    indent: indent,
                    marker: .ordered("\(digits)."),
                    text: String(afterDigits.dropFirst(2))
                )
            }
        }
        return nil
    }

    private static func isTableHeader(_ line: String, separator: String) -> Bool {
        guard line.contains("|") else { return false }
        let trimmed = separator.trimmingCharacters(in: .whitespaces)
        guard trimmed.contains("-") else { return false }
        let cells = splitTableRow(trimmed)
        guard !cells.isEmpty else { return false }
        return cells.allSatisfy { cell in
            let s = cell.trimmingCharacters(in: .whitespaces)
            guard s.count >= 3 else { return false }
            let core = s.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            return core.count >= 3 && core.allSatisfy { $0 == "-" }
        }
    }

    private static func splitTableRow(_ line: String) -> [String] {
        var trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("|") { trimmed.removeFirst() }
        if trimmed.hasSuffix("|") { trimmed.removeLast() }
        return trimmed.split(separator: "|", omittingEmptySubsequences: false).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
    }
}

/// Renders GitHub-flavoured Markdown blocks (headings, paragraphs, lists, checklists, code blocks,
/// blockquotes, tables, dividers and collapsible `<details>` sections) cleanly for mobile reading.
struct MarkdownView: View {
    private let blocks: [MarkdownBlock]

    init(_ text: String) {
        self.blocks = MarkdownParser.parse(text)
    }

    init(blocks: [MarkdownBlock]) {
        self.blocks = blocks
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(Fmt.inlineMarkdown(text))
                .font(level <= 2 ? .headline : .subheadline.weight(.semibold))
        case .paragraph(let text):
            Text(Fmt.inlineMarkdown(text))
        case .list(let items):
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        markerView(item.marker)
                        Text(Fmt.inlineMarkdown(item.text))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.leading, CGFloat(item.indent) * 14)
                }
            }
        case .codeBlock(let code):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.footnote.monospaced())
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(10)
            .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        case .blockquote(let text):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color.secondary.opacity(0.4))
                    .frame(width: 3)
                Text(Fmt.inlineMarkdown(text))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        case .table(let headers, let rows):
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                    GridRow {
                        ForEach(Array(headers.enumerated()), id: \.offset) { _, header in
                            Text(Fmt.inlineMarkdown(header))
                                .font(.footnote.weight(.semibold))
                        }
                    }
                    Divider()
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                Text(Fmt.inlineMarkdown(cell))
                                    .font(.footnote)
                            }
                        }
                    }
                }
                .padding(.vertical, 2)
            }
        case .details(let summary, let inner):
            DisclosureGroup {
                MarkdownView(blocks: inner)
                    .padding(.top, 4)
            } label: {
                Text(Fmt.inlineMarkdown(summary))
                    .fontWeight(.medium)
            }
        case .divider:
            Divider()
        }
    }

    @ViewBuilder
    private func markerView(_ marker: MarkdownListMarker) -> some View {
        switch marker {
        case .bullet:
            Text("•").foregroundStyle(.secondary)
        case .ordered(let label):
            Text(label).foregroundStyle(.secondary).monospacedDigit()
        case .task(let done):
            Image(systemName: done ? "checkmark.square.fill" : "square")
                .foregroundStyle(done ? Color.accentColor : Color.secondary)
                .font(.footnote)
        }
    }
}

extension View {
    /// A red banner for the last error, dismissed by tapping.
    func errorBanner(_ message: Binding<String?>) -> some View {
        safeAreaInset(edge: .top) {
            if let text = message.wrappedValue {
                Text(text)
                    .font(.callout)
                    .foregroundStyle(.white)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.red.gradient, in: RoundedRectangle(cornerRadius: 12))
                    .padding(.horizontal)
                    .onTapGesture { message.wrappedValue = nil }
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.default, value: message.wrappedValue)
    }
}
