import SwiftUI

/// Agent replies render as markdown: the agent writes lists, headings and
/// code, and plain Text leaves those markers literal. Block structure is
/// laid out natively; inline spans (bold, italic, code, links) go through
/// AttributedString's markdown parser, falling back to plain text when a
/// half-streamed fragment does not parse yet.
struct AgentMarkdownText: View {
    var text: String

    private enum Block {
        case paragraph(String)
        case heading(level: Int, text: String)
        case quote(String)
        case code(String)
        case list([(marker: String, text: String)])
    }

    var body: some View {
        if text.isEmpty {
            Text(" ")
        } else {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                    blockView(block)
                }
            }
        }
    }

    private var blocks: [Block] {
        let lines = text.components(separatedBy: "\n")
        var out: [Block] = []
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if line.hasPrefix("```") {
                var code: [String] = []
                i += 1
                while i < lines.count, !lines[i].hasPrefix("```") {
                    code.append(lines[i])
                    i += 1
                }
                i += 1
                out.append(.code(code.joined(separator: "\n")))
            } else if let heading = parseHeading(line) {
                out.append(.heading(level: heading.level, text: heading.text))
                i += 1
            } else if line.hasPrefix("> ") || line == ">" {
                var quote: [String] = []
                while i < lines.count, lines[i].hasPrefix("> ") || lines[i] == ">" {
                    quote.append(lines[i].hasPrefix("> ") ? String(lines[i].dropFirst(2)) : "")
                    i += 1
                }
                out.append(.quote(quote.joined(separator: "\n")))
            } else if let item = parseListItem(line) {
                var items: [(marker: String, text: String)] = [item]
                i += 1
                while i < lines.count, let next = parseListItem(lines[i]) {
                    items.append(next)
                    i += 1
                }
                out.append(.list(items))
            } else if line.trimmingCharacters(in: .whitespaces).isEmpty {
                i += 1
            } else {
                var paragraph: [String] = [line]
                i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).isEmpty,
                      !lines[i].hasPrefix("```"), parseHeading(lines[i]) == nil,
                      !lines[i].hasPrefix("> "), parseListItem(lines[i]) == nil {
                    paragraph.append(lines[i])
                    i += 1
                }
                out.append(.paragraph(paragraph.joined(separator: "\n")))
            }
        }
        return out
    }

    private func parseHeading(_ line: String) -> (level: Int, text: String)? {
        var level = 0
        for char in line {
            guard char == "#" else { break }
            level += 1
        }
        guard (1...3).contains(level), line.dropFirst(level).hasPrefix(" ") else { return nil }
        return (level, String(line.dropFirst(level + 1)))
    }

    private func parseListItem(_ line: String) -> (marker: String, text: String)? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        for prefix in ["- ", "* ", "• "] {
            if trimmed.hasPrefix(prefix) {
                return ("•", String(trimmed.dropFirst(prefix.count)))
            }
        }
        if let dot = trimmed.firstIndex(of: ".") {
            let number = trimmed[..<dot]
            if !number.isEmpty, number.allSatisfy(\.isNumber),
               trimmed[trimmed.index(after: dot)..<trimmed.endIndex].hasPrefix(" ") {
                return (String(number) + ".", String(trimmed[trimmed.index(after: dot)...].dropFirst()))
            }
        }
        return nil
    }

    private func inline(_ string: String) -> Text {
        if let parsed = try? AttributedString(
            markdown: string,
            options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            return Text(parsed)
        }
        return Text(string)
    }

    private func bodyText(_ string: String) -> some View {
        inline(string).font(.body).foregroundStyle(HyggeTheme.ink).lineSpacing(3)
    }

    @ViewBuilder
    private func blockView(_ block: Block) -> some View {
        switch block {
        case .paragraph(let string):
            bodyText(string)
        case .heading(let level, let string):
            inline(string)
                .font(level == 1 ? .headline : .subheadline.weight(.semibold))
                .foregroundStyle(HyggeTheme.ink).lineSpacing(3)
        case .quote(let string):
            HStack(alignment: .top, spacing: 8) {
                Capsule().fill(HyggeTheme.sageDeep).frame(width: 3)
                bodyText(string)
            }
        case .code(let string):
            Text(string)
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(HyggeTheme.ink).lineSpacing(3)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(HyggeTheme.paperDeep, in: RoundedRectangle(cornerRadius: 8))
        case .list(let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .top, spacing: 6) {
                        Text(item.marker).font(.body).foregroundStyle(HyggeTheme.ink)
                        bodyText(item.text)
                    }
                }
            }
        }
    }
}
