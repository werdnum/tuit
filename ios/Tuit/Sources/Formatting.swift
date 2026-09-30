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

    /// Brief and notes are GitHub-flavoured Markdown. SwiftUI renders the inline parts; the
    /// <details> wrappers the web uses for collapsing become plain lines.
    static func markdown(_ s: String) -> AttributedString {
        let cleaned = s
            .replacingOccurrences(of: "<details>", with: "")
            .replacingOccurrences(of: "</details>", with: "")
            .replacingOccurrences(of: "<summary>", with: "**")
            .replacingOccurrences(of: "</summary>", with: "**")
            // Inline parsing leaves list markers as typed; show them as bullets.
            .replacingOccurrences(of: #"(?m)^(\s*)[-*] "#, with: "$1• ", options: .regularExpression)
        let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: cleaned, options: opts)) ?? AttributedString(s)
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
