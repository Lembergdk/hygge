import SwiftUI
import WebKit

/// Email content has no JavaScript, persistent web storage, remote resources,
/// forms or automatic navigation. Only deliberate HTTP(S) link taps leave the reader.
struct OriginalEmailBodyView: View {
    let original: OriginalEmail
    @State private var height: CGFloat = 200
    @Environment(\.openURL) private var openURL
    var body: some View {
        if let html = original.html, !html.isEmpty {
            IsolatedEmailHTML(html: html, fallback: original.text, height: $height) { openURL($0) }
                .frame(height: height)
            Text("Remote images are blocked.").font(.caption).foregroundStyle(HyggeTheme.secondary)
        } else {
            Text(original.text.isEmpty ? "This email has no readable body." : original.text)
                .font(.body).foregroundStyle(HyggeTheme.ink).textSelection(.enabled)
        }
    }
}

private struct IsolatedEmailHTML: UIViewRepresentable {
    let html: String
    let fallback: String
    @Binding var height: CGFloat
    let openLink: (URL) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(height: $height, openLink: openLink) }
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: .zero, configuration: config)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.navigationDelegate = context.coordinator
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        guard context.coordinator.content != html else { return }
        context.coordinator.content = html
        context.coordinator.awaitingDocument = true
        // No email HTML is loaded until the network blocker is installed.
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "HyggeOriginalEmailNoNetwork-v1",
            encodedContentRuleList: """
                [{"trigger":{"url-filter":".*"},"action":{"type":"block"}}]
                """
        ) { [weak view] rules, _ in
            guard let view else { return }
            if let rules {
                view.configuration.userContentController.add(rules)
                view.loadHTMLString(Self.document(html), baseURL: nil)
            } else {
                view.loadHTMLString(
                    Self.document("<pre>" + Self.escape(fallback) + "</pre>"), baseURL: nil)
            }
        }
    }
    private static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(
            of: "<", with: "&lt;"
        ).replacingOccurrences(of: ">", with: "&gt;")
    }
    private static func document(_ body: String) -> String {
        """
        <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'"><style>:root{color-scheme:light dark}body{font:17px -apple-system;margin:0;overflow-wrap:anywhere}img,table{max-width:100%;height:auto}pre{white-space:pre-wrap}a{color:#3e5c38}</style></head><body>\(body)</body></html>
        """
    }
    final class Coordinator: NSObject, WKNavigationDelegate {
        var height: Binding<CGFloat>
        var content: String?
        var awaitingDocument = true
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.evaluateJavaScript("Math.ceil(document.body.getBoundingClientRect().height)") {
                [weak self, weak webView] result, _ in
                guard let self, let webView else { return }
                let bodyHeight = (result as? NSNumber)?.doubleValue ?? 500
                self.height.wrappedValue = min(max(CGFloat(bodyHeight) + 12, 180), 1600)
                webView.scrollView.isScrollEnabled = bodyHeight > 1600
            }
        }
        let openLink: (URL) -> Void
        init(height: Binding<CGFloat>, openLink: @escaping (URL) -> Void) {
            self.height = height
            self.openLink = openLink
        }
        func webView(
            _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if navigationAction.navigationType == .linkActivated,
                let url = navigationAction.request.url,
                ["https", "http"].contains(url.scheme?.lowercased() ?? "")
            {
                openLink(url)
            }
            // Allow only the local loadHTMLString document, not refreshes, frames or navigations supplied by an email.
            let initial =
                navigationAction.navigationType == .other
                && navigationAction.targetFrame?.isMainFrame == true
                && navigationAction.request.url?.absoluteString == "about:blank" && awaitingDocument
            if initial { awaitingDocument = false }
            decisionHandler(initial ? .allow : .cancel)
        }
    }
}
