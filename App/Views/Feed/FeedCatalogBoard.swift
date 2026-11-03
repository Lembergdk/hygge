#if DEBUG
import SwiftUI

/// A visual inventory rendered from the production card components. This is an
/// internal review artifact, not another product screen or production fixture.
struct FeedCatalogBoard: View {
    var liveTask: AgentTask?
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 20, alignment: .top), count: 3)
    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            Text("Hygge · the feed objects").font(.system(size: 36, weight: .bold, design: .rounded)).foregroundStyle(HyggeTheme.ink)
            Text("Production components · illustrative local data · collapsed states")
                .font(.title3).foregroundStyle(HyggeTheme.secondary)
            LazyVGrid(columns: columns, alignment: .leading, spacing: 28) {
                sample("01 · Site suggestion", style: .invitation, title: "Upwork", subtitle: "A place for your design and writing", icon: "globe")
                sample("02 · Work opportunity", style: .opportunity, title: "Brand refresh for a local café", subtitle: "$450 fixed · Remote", icon: "paintpalette")
                VStack(alignment: .leading, spacing: 10) {
                    Text("03 · Live work").font(.headline).foregroundStyle(HyggeTheme.secondary)
                    if let liveTask {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Building your profile").font(.subheadline.bold()).foregroundStyle(HyggeTheme.ink)
                            BrowserLiveAttachment(task: liveTask) {}
                        }.padding(14).hyggeCard(radius: 22)
                    } else {
                        FeedVisualCard(style: .update, title: "Setting up your account", subtitle: "Workroom · Connecting", icon: "globe")
                    }
                }
                sample("04 · Profile review", style: .review, title: "Profile ready to review", subtitle: "Contra · Public profile", icon: "person.text.rectangle", portrait: true)
                sample("05 · Application review", style: .review, title: "Application ready", subtitle: "Café brand refresh · Upwork", icon: "envelope.open")
                sample("06 · Message review", style: .review, title: "Reply ready to send", subtitle: "Contra", icon: "paperplane")
                sample("07 · Calendar review", style: .review, title: "Ready to add to your calendar", subtitle: "Project introduction", icon: "calendar.badge.plus")
                sample("08 · Question → chat", style: .question, title: "One quick question", subtitle: "Workroom", icon: "bubble.left.and.bubble.right")
                sample("09 · Verification → chat", style: .question, title: "A quick check needs you", subtitle: "Fiverr", icon: "checkmark.shield")
                sample("10 · Login help → chat", style: .question, title: "Connect your login", subtitle: "Upwork", icon: "key")
                sample("11 · Recovery → chat", style: .question, title: "Let’s get this moving", subtitle: "Workroom", icon: "arrow.clockwise")
                sample("12 · New public action → chat review", style: .review, title: "Ready for your review", subtitle: "Workroom", icon: "doc.text.magnifyingglass")
                sample("13 · Earnings", style: .earnings(120, "USD"), title: "You earned $120", subtitle: "Design project · Contra", icon: "banknote")
                sample("14 · Account connected", style: .update, title: "Your account is ready", subtitle: "Contra", icon: "checkmark.circle.fill")
                sample("15 · Profile published", style: .update, title: "Your profile is live", subtitle: "Workroom", icon: "checkmark.circle.fill")
                sample("16 · Application sent", style: .update, title: "Application sent", subtitle: "Upwork", icon: "paperplane")
                sample("17 · Message sent", style: .update, title: "Message sent", subtitle: "Contra", icon: "bubble.left")
                sample("18 · Booking completed", style: .update, title: "It’s in your calendar", subtitle: "Project introduction", icon: "calendar")
                sample("19 · Search outcome", style: .update, title: "Checked Upwork for new work", subtitle: "Today", icon: "magnifyingglass")
                sample("20 · Site learning", style: .update, title: "Found a smoother way to sign in", subtitle: "Workroom", icon: "map")
                sample("21 · Email filed", style: .update, title: "A new message about your project", subtitle: "Contra", icon: "envelope")
                sample("22 · Permission reminder", style: .update, title: "A heads-up when you need it", subtitle: "New work and things that need your OK", icon: "bell")
                sample("23 · Paused", style: .update, title: "Hygge is paused", subtitle: "Your work is here when you’re ready", icon: "pause")
                VStack(alignment: .leading, spacing: 14) {
                    Text("24 · Empty / caught up").font(.headline).foregroundStyle(HyggeTheme.secondary)
                    Text("You’re all caught up.").font(.system(.title3, design: .rounded, weight: .semibold)).foregroundStyle(HyggeTheme.ink)
                    Text("No filler card. Earlier and Your work remain accessible.").font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                }
            }
            Text("Tap → the object lifts forward and expands. Short swipe → reveal. Long swipe → trigger on release. Public actions always open review.")
                .font(.title3).foregroundStyle(HyggeTheme.sageDeep)
        }.padding(32).frame(width: 1140).background(HyggeTheme.paper)
    }
    private func sample(_ name: String, style: FeedCardStyle, title: String, subtitle: String, icon: String, portrait: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(name).font(.headline).foregroundStyle(HyggeTheme.secondary)
            FeedVisualCard(style: style, title: title, subtitle: subtitle, icon: icon, usesProfilePhoto: portrait)
        }
    }
}
#endif
