import SwiftUI

/// Where the carousel hands off: into the onboarding conversation
/// (sign-in is its final step), or — for someone who already has an
/// account — straight to that conversation's sign-in message.
enum AuthDestination: Equatable {
    case signup
    case signIn
}

/// The 3-screen prelude before signup (Who → How → Where), shown once
/// on first launch. Copy: docs/design/onboarding-package/
/// ONBOARDING-BUILD-SPEC.md (exact — do not reword).
///
/// The flame is NOT part of any page: one persistent flame sits in the
/// same spot at the same size on every screen and crossfades between
/// its animations (walk → laptop → notify) in step with the swipe,
/// while the page content slides underneath it.
struct IntroCarouselView: View {
    var onFinish: (AuthDestination) -> Void

    @State private var pageId: Int? = {
        #if DEBUG
        // Design/screenshot checks: launch with `-introPage 2`.
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-introPage"), args.indices.contains(i + 1),
           let n = Int(args[i + 1]) { return min(max(n, 0), 2) }
        #endif
        return 0
    }()
    @State private var entrancePlayed = false

    /// One size, one position, every screen.
    static let flameSize: CGFloat = 150
    static let flameTop: CGFloat = 168
    /// Vertical space pages reserve under the flame.
    static var flameZone: CGFloat { flameTop + flameSize * 1.25 + 14 }

    private var page: Int { pageId ?? 0 }

    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 0) {
                GeometryReader { area in
                ZStack(alignment: .topTrailing) {
                    pager(pageWidth: area.size.width, pageHeight: area.size.height)
                    PersistentFlame(page: page)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.top, Self.flameTop)
                        .allowsHitTesting(false)
                    Button("Skip") { onFinish(.signup) }
                        .font(.body)
                        .foregroundStyle(HyggeTheme.secondary)
                        .padding(.top, 14)
                        .padding(.trailing, 22)
                        .accessibilityLabel("Skip introduction")
                }
                }
                bottomCluster
            }
            .background(HyggeTheme.paper)
        }
        .fontDesign(.rounded)
    }

    private func pager(pageWidth: CGFloat, pageHeight: CGFloat) -> some View {
        ScrollViewReader { proxy in
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                whoPage(width: pageWidth, height: pageHeight).id(0)
                howPage(width: pageWidth, height: pageHeight).id(1)
                Screen3Page(entrancePlayed: $entrancePlayed, isCurrent: page == 2,
                            width: pageWidth, height: pageHeight).id(2)
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.paging)
        .scrollPosition(id: $pageId)
        .onAppear {
            // scrollPosition alone doesn't land a non-zero initial page.
            if page != 0 { proxy.scrollTo(page, anchor: .leading) }
        }
        }
    }

    // MARK: - Fixed bottom cluster: dots, button, (page 3) sign-in.
    // In layout flow (never overlaid), with a constant height, so page
    // content can never slide underneath it at any text size.

    private var bottomCluster: some View {
        VStack(spacing: 14) {
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
                    withAnimation { pageId = page + 1 }
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

            // Constant-height row: only visible/tappable on page 3, so
            // the cluster never resizes (and pages never jump) mid-swipe.
            Button { onFinish(.signIn) } label: {
                Text("Already have an account? Sign in")
                    .font(.subheadline)
                    .foregroundStyle(HyggeTheme.secondary)
            }
            .buttonStyle(.plain)
            .opacity(page == 2 ? 1 : 0)
            .allowsHitTesting(page == 2)
            .accessibilityHidden(page != 2)
        }
        .padding(.horizontal, 22)
        .padding(.top, 10)
        .padding(.bottom, 8)
    }

    // MARK: - Page shell: reserves the flame zone, scrolls vertically
    // when large text needs more room than the screen has.

    @Environment(\.dynamicTypeSize) private var typeSize

    private func pageShell<Content: View>(topReserve: CGFloat, width: CGFloat, height: CGFloat,
                                          @ViewBuilder content: @escaping () -> Content) -> some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 0) {
                Color.clear.frame(height: topReserve)
                content()
                Spacer(minLength: 0)
            }
            .frame(width: width)
            .frame(minHeight: height)
        }
        .frame(width: width, height: height)
        .scrollBounceBehavior(.basedOnSize)
        .scrollDisabled(!typeSize.isAccessibilitySize)
    }

    // MARK: - Screen 1: Who

    private func whoPage(width: CGFloat, height: CGFloat) -> some View {
        pageShell(topReserve: Self.flameZone, width: width, height: height) {
            Text("Hi, I'm Hygge,")
                .font(.system(size: 36, weight: .bold, design: .rounded))
                .foregroundStyle(HyggeTheme.ink)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
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
                .padding(.horizontal, 28)
        }
    }

    // MARK: - Screen 2: How

    private func howPage(width: CGFloat, height: CGFloat) -> some View {
        pageShell(topReserve: Self.flameZone, width: width, height: height) {
            Text("I work on my own\ncomputer.")
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .foregroundStyle(HyggeTheme.ink)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Text("I have my own browser and manage your profiles on the work sites you allow. Nothing happens without your approval.")
                .font(.body)
                .foregroundStyle(HyggeTheme.ink)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 16)
                .padding(.horizontal, 28)
        }
    }
}

/// The one flame for the whole carousel. Crossfades between the three
/// animations with swipe progress, so Hygge morphs in place while the
/// screens slide underneath. SWAP POINT: page 3 uses the notify
/// animation as a placeholder until the pointing animation lands.
private struct PersistentFlame: View {
    var page: Int

    private let animations: [FlameAnimation] = [.walk, .laptop, .notify]

    var body: some View {
        ZStack {
            ForEach(animations.indices, id: \.self) { i in
                AnimatedFlame(animation: animations[i], size: IntroCarouselView.flameSize)
                    .opacity(i == page ? 1 : 0)
            }
        }
        .animation(.easeInOut(duration: 0.45), value: page)
        .frame(width: IntroCarouselView.flameSize,
               height: IntroCarouselView.flameSize * 1.25)
        .accessibilityHidden(true)
    }
}

// MARK: - Screen 3: Where

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
    var width: CGFloat
    var height: CGFloat
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 0) {
                    // Mockups sit ABOVE the persistent flame; the
                    // flame (an overlay) overlaps their lower edge,
                    // and the headline starts below the flame.
                    Color.clear.frame(height: 52)
                    mockups
                        .scaleEffect(typeSize.isAccessibilitySize ? 0.85 : 0.92, anchor: .top)
                        .frame(height: typeSize.isAccessibilitySize ? 172 : 186)
                    Color.clear.frame(height: max(6, IntroCarouselView.flameZone - 52 - (typeSize.isAccessibilitySize ? 172 : 186)))
                    Text("One feed for all\nyour work")
                        .font(.system(size: 34, weight: .bold, design: .rounded))
                        .foregroundStyle(HyggeTheme.ink)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 20)
                    Text("Everything I do is posted in the feed. If I need your attention on anything, I will send you a message.")
                        .font(.body)
                        .foregroundStyle(HyggeTheme.ink)
                        .multilineTextAlignment(.center)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 12)
                        .padding(.horizontal, 6)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 22)
                .frame(width: width)
                .frame(minHeight: height)
        }
        .frame(width: width, height: height)
        .scrollBounceBehavior(.basedOnSize)
        .scrollDisabled(!typeSize.isAccessibilitySize)
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
        HStack(alignment: .top, spacing: 12) {
            miniFeed
                .modifier(Entrance(shown: shown, delay: 0, duration: 0.30, fadeOnly: true))
            bubbles
                .padding(.top, 30)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Preview of your feed, with an approval, a journal entry, and messages from Hygge")
    }

    private var miniFeed: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 4) {
                Circle().fill(MiniPalette.coral).frame(width: 6, height: 6)
                Text("Pinned • Needs you")
                    .font(.system(size: 8, weight: .semibold, design: .rounded))
                    .foregroundStyle(MiniPalette.coral)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("Dog walk approval")
                    .font(.system(size: 10.5, weight: .bold, design: .rounded))
                    .foregroundStyle(MiniPalette.ink)
                Text("Luna • Golden Retriever")
                    .font(.system(size: 8, design: .rounded))
                    .foregroundStyle(MiniPalette.muted)
                Text("Today • 7:30–8:30pm")
                    .font(.system(size: 8, design: .rounded))
                    .foregroundStyle(MiniPalette.muted)
                HStack {
                    Spacer()
                    Text("Approve")
                        .font(.system(size: 8, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 2.5)
                        .background(MiniPalette.coral, in: Capsule())
                }
                .padding(.top, 2)
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 10))
            .modifier(Entrance(shown: shown, delay: 0.10, duration: 0.35))

            VStack(alignment: .leading, spacing: 2) {
                Text("Journal")
                    .font(.system(size: 8.5, weight: .bold, design: .rounded))
                    .foregroundStyle(MiniPalette.ink)
                Text("Walked Finley in Botanical Gardens. Felt calm and sunny.")
                    .font(.system(size: 8, design: .rounded))
                    .foregroundStyle(MiniPalette.ink.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .modifier(Entrance(shown: shown, delay: 0.20, duration: 0.35))

            VStack(alignment: .leading, spacing: 1) {
                Text("Time saved this week")
                    .font(.system(size: 7.5, design: .rounded))
                    .foregroundStyle(MiniPalette.muted)
                Text("4h 20m")
                    .font(.system(size: 11.5, weight: .bold, design: .rounded))
                    .foregroundStyle(MiniPalette.ink)
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(MiniPalette.sageStrip, in: RoundedRectangle(cornerRadius: 9))
            .modifier(Entrance(shown: shown, delay: 0.30, duration: 0.35))
        }
        .padding(9)
        .frame(maxWidth: .infinity)
        .background(MiniPalette.cream, in: RoundedRectangle(cornerRadius: 15))
        .overlay(RoundedRectangle(cornerRadius: 15).stroke(HyggeTheme.hairline, lineWidth: 1))
        .shadow(color: Color.black.opacity(0.14), radius: 12, y: 5)
    }

    private var bubbles: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .bottom, spacing: 6) {
                FlameMark(size: 22)
                Text("Found a walk near Zilker Park that fits your mornings")
                    .font(.system(size: 9, design: .rounded))
                    .foregroundStyle(MiniPalette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 8).padding(.vertical, 6)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(HyggeTheme.hairline, lineWidth: 1))
            }
            .modifier(Entrance(shown: shown, delay: 0.15, duration: 0.35))

            HStack(alignment: .bottom, spacing: 6) {
                Spacer()
                Text("Yes, book it.")
                    .font(.system(size: 9, design: .rounded))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .background(MiniPalette.sageBubble, in: RoundedRectangle(cornerRadius: 12))
                ZStack {
                    Circle().fill(HyggeTheme.secondary.opacity(0.30))
                    Image(systemName: "person.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(HyggeTheme.secondary)
                }
                .frame(width: 22, height: 22)
            }
            .modifier(Entrance(shown: shown, delay: 0.35, duration: 0.35))
        }
        .frame(maxWidth: .infinity)
    }
}
