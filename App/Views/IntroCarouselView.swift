import SwiftUI

/// Where the carousel hands off. The signup screen itself is a later
/// deliverable (auth method still open — see
/// docs/design/onboarding-package/ONBOARDING-BUILD-SPEC.md §9); this
/// is the single swap point when it lands.
enum AuthDestination {
    case signup
    case signIn
}

/// The 3-screen prelude before signup (Who → How → Where), shown once
/// on first launch. Spec: docs/design/onboarding-package/
/// ONBOARDING-BUILD-SPEC.md. Copy there is exact — do not reword.
struct IntroCarouselView: View {
    var onFinish: (AuthDestination) -> Void

    @State private var page: Int = {
        #if DEBUG
        // Design/screenshot checks: launch with `-introPage 2`.
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-introPage"), args.indices.contains(i + 1),
           let n = Int(args[i + 1]) { return min(max(n, 0), 2) }
        #endif
        return 0
    }()
    @State private var entrancePlayed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .topTrailing) {
            HyggeTheme.paper.ignoresSafeArea()

            TabView(selection: $page) {
                whoPage.tag(0)
                howPage.tag(1)
                Screen3Page(entrancePlayed: $entrancePlayed, isCurrent: page == 2).tag(2)
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .ignoresSafeArea(edges: .bottom)

            Button("Skip") { onFinish(.signup) }
                .font(.body)
                .foregroundStyle(HyggeTheme.secondary)
                .padding(.top, 14)
                .padding(.trailing, 22)
                .accessibilityLabel("Skip introduction")

            bottomCluster
        }
        .fontDesign(.rounded)
    }

    // MARK: - Fixed bottom cluster: dots, button, (page 3) sign-in

    private var bottomCluster: some View {
        VStack(spacing: 16) {
            Spacer()
            HStack(spacing: 8) {
                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .fill(index == page ? HyggeTheme.ember : HyggeTheme.secondary.opacity(0.45))
                        .frame(width: 9, height: 9)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Page \(page + 1) of 3")

            Button {
                if page < 2 {
                    withAnimation { page += 1 }
                } else {
                    onFinish(.signup)
                }
            } label: {
                Text(page < 2 ? "Next" : "Get started")
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: .infinity).padding(.vertical, 17)
                    .background(HyggeTheme.emberDeep, in: Capsule())
                    .foregroundStyle(.white)
            }
            .buttonStyle(.plain)

            if page == 2 {
                Button { onFinish(.signIn) } label: {
                    Text("Already have an account? Sign in")
                        .font(.subheadline)
                        .foregroundStyle(HyggeTheme.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 22)
        .padding(.bottom, 10)
    }

    // MARK: - Screen 1: Who (the existing welcome hero + chrome)

    private var whoPage: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 60)
            AnimatedFlame(animation: .walk, size: 150)
            Text("Hi, I'm Hygge,")
                .font(.system(size: 36, weight: .bold, design: .rounded))
                .foregroundStyle(HyggeTheme.ink)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 26)
            Text("hoo-gah")
                .font(.headline)
                .foregroundStyle(HyggeTheme.emberDeep)
                .padding(.top, 6)
            Text("I find work you like and handle\nthe boring parts.")
                .font(.body)
                .foregroundStyle(HyggeTheme.ink)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 14)
            Spacer(minLength: 170)
        }
        .padding(.horizontal, 28)
        .accessibilityElement(children: .contain)
    }

    // MARK: - Screen 2: How

    private var howPage: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 60)
            AnimatedFlame(animation: .laptop, size: 210)
            Text("I work on my own\ncomputer.")
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .foregroundStyle(HyggeTheme.ink)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 30)
            Text("I have my own browser and manage your profiles on the work sites you allow. Nothing happens without your approval.")
                .font(.body)
                .foregroundStyle(HyggeTheme.ink)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 14)
            Spacer(minLength: 170)
        }
        .padding(.horizontal, 28)
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Screen 3: Where

/// The flame below the mockups. SWAP POINT (spec §6): the pointing
/// animation from Mikael's team drops in here later — FlameNotify is
/// the placeholder. The flame never joins the entrance sequence.
private struct Screen3Flame: View {
    var body: some View {
        AnimatedFlame(animation: .notify, size: 116)
    }
}

/// One entrance step: fade (+ gentle rise unless fadeOnly), ease-out,
/// with its stagger delay (spec §6 timings).
private struct Entrance: ViewModifier {
    var shown: Bool
    var delay: Double
    var duration: Double
    var fadeOnly = false

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown || fadeOnly ? 0 : 16)
            .animation(.easeOut(duration: duration).delay(delay), value: shown)
    }
}

/// The mini-mockups are illustrations, not live UI (spec §5): fixed
/// light palette picturing the feed, hardcoded copy, non-interactive.
private enum MiniPalette {
    static let cream = Color(red: 0.980, green: 0.965, blue: 0.937)
    static let ink = Color(red: 0.169, green: 0.137, blue: 0.125)
    static let muted = Color(red: 0.478, green: 0.416, blue: 0.380)
    static let coral = Color(red: 0.788, green: 0.227, blue: 0.149)
    static let sageStrip = Color(red: 0.894, green: 0.922, blue: 0.867)
    static let sageBubble = Color(red: 0.66, green: 0.78, blue: 0.63)
}

private struct Screen3Page: View {
    @Binding var entrancePlayed: Bool
    var isCurrent: Bool
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 40)
            mockups
            Screen3Flame().padding(.top, 16)
            Text("One feed for all\nyour work")
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .foregroundStyle(HyggeTheme.ink)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 18)
            Text("Everything I do is posted in the feed. If I need your attention on anything, I will send you a message.")
                .font(.body)
                .foregroundStyle(HyggeTheme.ink)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 14)
            Spacer(minLength: 140)
        }
        .padding(.horizontal, 22)
        .onAppear { if isCurrent { startEntrance() } }
        .onChange(of: isCurrent) { _, current in
            if current { startEntrance() }
        }
    }

    private func startEntrance() {
        if entrancePlayed || reduceMotion {
            // End state immediately: no replay, no motion.
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { shown = true }
            entrancePlayed = true
        } else {
            entrancePlayed = true
            shown = true
        }
    }

    // Entrance sequence (spec §6): feed bg 0/300 fade-only; approval
    // 100/350; journal 200/350; strip 300/350; Hygge bubble 150/350;
    // user bubble 350/350. Rise = y 16→0 + opacity, ease-out.
    private var mockups: some View {
        HStack(alignment: .top, spacing: 14) {
            miniFeed
                .modifier(Entrance(shown: shown, delay: 0, duration: 0.30, fadeOnly: true))
            bubbles
                .padding(.top, 40)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Preview of your feed, with an approval, a journal entry, and messages from Hygge")
    }

    private var miniFeed: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 4) {
                Circle().fill(MiniPalette.coral).frame(width: 6, height: 6)
                Text("Pinned • Needs you")
                    .font(.system(size: 8.5, weight: .semibold, design: .rounded))
                    .foregroundStyle(MiniPalette.coral)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("Dog walk approval")
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .foregroundStyle(MiniPalette.ink)
                Text("Luna • Golden Retriever")
                    .font(.system(size: 8.5, design: .rounded))
                    .foregroundStyle(MiniPalette.muted)
                Text("Today • 7:30–8:30pm")
                    .font(.system(size: 8.5, design: .rounded))
                    .foregroundStyle(MiniPalette.muted)
                HStack {
                    Spacer()
                    Text("Approve")
                        .font(.system(size: 8.5, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(MiniPalette.coral, in: Capsule())
                }
                .padding(.top, 3)
            }
            .padding(9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 10))
            .modifier(Entrance(shown: shown, delay: 0.10, duration: 0.35))

            VStack(alignment: .leading, spacing: 2) {
                Text("Journal")
                    .font(.system(size: 9, weight: .bold, design: .rounded))
                    .foregroundStyle(MiniPalette.ink)
                Text("Walked Finley in Botanical Gardens. Felt calm and sunny.")
                    .font(.system(size: 8.5, design: .rounded))
                    .foregroundStyle(MiniPalette.ink.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .modifier(Entrance(shown: shown, delay: 0.20, duration: 0.35))

            VStack(alignment: .leading, spacing: 1) {
                Text("Time saved this week")
                    .font(.system(size: 8, design: .rounded))
                    .foregroundStyle(MiniPalette.muted)
                Text("4h 20m")
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .foregroundStyle(MiniPalette.ink)
            }
            .padding(.horizontal, 9).padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(MiniPalette.sageStrip, in: RoundedRectangle(cornerRadius: 9))
            .modifier(Entrance(shown: shown, delay: 0.30, duration: 0.35))
        }
        .padding(11)
        .frame(maxWidth: .infinity)
        .background(MiniPalette.cream, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(HyggeTheme.hairline, lineWidth: 1))
        .shadow(color: Color.black.opacity(0.14), radius: 12, y: 5)
    }

    private var bubbles: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .bottom, spacing: 6) {
                FlameMark(size: 24)
                Text("Found a walk near Zilker Park that fits your mornings")
                    .font(.system(size: 9.5, design: .rounded))
                    .foregroundStyle(MiniPalette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 9).padding(.vertical, 7)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(HyggeTheme.hairline, lineWidth: 1))
            }
            .modifier(Entrance(shown: shown, delay: 0.15, duration: 0.35))

            HStack(alignment: .bottom, spacing: 6) {
                Spacer()
                Text("Yes, book it.")
                    .font(.system(size: 9.5, design: .rounded))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 9).padding(.vertical, 6)
                    .background(MiniPalette.sageBubble, in: RoundedRectangle(cornerRadius: 12))
                ZStack {
                    Circle().fill(HyggeTheme.secondary.opacity(0.30))
                    Image(systemName: "person.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(HyggeTheme.secondary)
                }
                .frame(width: 24, height: 24)
            }
            .modifier(Entrance(shown: shown, delay: 0.35, duration: 0.35))
        }
        .frame(maxWidth: .infinity)
    }
}
