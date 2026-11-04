import SwiftUI

/// Different stories deserve different compositions, not a stack of identical rows.
enum FeedCardStyle {
    case invitation, opportunity, review, question, earnings(Double, String), celebration, update
}

struct FeedVisualCard: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize
    let style: FeedCardStyle
    let title: String
    let subtitle: String
    let icon: String
    var asset: String?
    var usesProfilePhoto = false
    /// The job site this card is about, when it is about one:
    /// its real mark replaces generic glyphs (see SiteLogoTile).
    var siteDomain: String?
    var siteName: String?
    var body: some View {
        Group {
            switch style {
            case .invitation: invitation
            case .opportunity: opportunity
            case .review: review
            case .question: question
            case .earnings(let amount, let currency): earnings(amount, currency)
            case .celebration: celebration
            case .update: update
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HyggeTheme.card)
        .clipShape(RoundedRectangle(cornerRadius: 24))
        .overlay(RoundedRectangle(cornerRadius: 24).stroke(HyggeTheme.hairline, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
    /// A proposed new job site. The card's whole job is to make
    /// one thing obvious: Hygge is asking to start scanning this
    /// site for work. Site mark, the words JOB SITE, and three
    /// plain steps — no globe, no unlabeled glyph strip.
    private var invitation: some View {
        let name = siteName ?? title
        return VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .center, spacing: 14) {
                if !typeSize.isAccessibilitySize {
                    SiteLogoTile(domain: siteDomain ?? "", name: name, size: 56)
                }
                VStack(alignment: .leading, spacing: 3) {
                    eyebrow("NEW JOB SITE")
                    Text(name).font(.system(.title2, design: .rounded, weight: .bold))
                        .fixedSize(horizontal: false, vertical: true)
                    if let siteDomain, !siteDomain.isEmpty {
                        Text(siteDomain).font(.caption).foregroundStyle(HyggeTheme.secondary)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
                arrow
            }
            // The rationale is the reason to tap: wrap it fully.
            Text(subtitle).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 9) {
                invitationStep("person.crop.circle.badge.plus", "I set up your account")
                invitationStep("magnifyingglass", "Then I scan \(name) for work that fits you")
                invitationStep("tray", "Matches appear here for your OK")
            }
            Text("Say yes and I'll start. Tap to see what's shared.")
                .font(.subheadline).foregroundStyle(HyggeTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
        }.foregroundStyle(HyggeTheme.ink).padding(20)
    }
    private func invitationStep(_ icon: String, _ text: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon).font(.subheadline.weight(.medium))
                .foregroundStyle(HyggeTheme.sageDeep).frame(width: 22)
                .accessibilityHidden(true)
            Text(text).font(.subheadline).foregroundStyle(HyggeTheme.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
    private var opportunity: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                if let siteDomain, !typeSize.isAccessibilitySize {
                    SiteLogoTile(domain: siteDomain, name: siteName ?? title, size: 44)
                }
                VStack(alignment: .leading, spacing: 3) {
                    eyebrow("FOUND FOR YOU")
                    if let siteName {
                        Text("on \(siteName)").font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.ink)
                    }
                }
                Spacer()
                Image(systemName: icon).font(.title3).foregroundStyle(HyggeTheme.butterText)
                    .accessibilityHidden(true)
            }.padding(.horizontal, 20).padding(.vertical, 14)
                .background(HyggeTheme.butterTint)
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top, spacing: 10) {
                    Text(title).font(.system(.title3, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    arrow
                }
                // Pay/place is decision-critical: full width, wraps,
                // never shares its line with the arrow.
                Text(subtitle).font(.subheadline.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep)
                    .fixedSize(horizontal: false, vertical: true)
            }.padding(20)
        }
    }
    private var review: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                if usesProfilePhoto { ProfileAvatar(size: 60).accessibilityHidden(true) }
                else if let siteDomain {
                    SiteLogoTile(domain: siteDomain, name: siteName ?? title, size: 60)
                }
                else {
                    Image(systemName: icon).font(.system(size: 38, weight: .light)).foregroundStyle(HyggeTheme.butterText)
                        .frame(width: 60, height: 60).background(HyggeTheme.butterTint, in: RoundedRectangle(cornerRadius: 18)).accessibilityHidden(true)
                }
                Spacer()
                Text("FOR YOUR OK").font(.caption2.weight(.bold)).foregroundStyle(HyggeTheme.butterText)
                    .padding(.horizontal, 10).padding(.vertical, 7).background(HyggeTheme.butterTint, in: Capsule())
            }
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .top, spacing: 10) {
                    Text(title).font(.system(.title3, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    arrow
                }
                Text(subtitle).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }.padding(20)
    }
    private var question: some View {
        HStack(alignment: .top, spacing: 16) {
            Image(systemName: icon).font(.system(size: 28, weight: .medium)).foregroundStyle(HyggeTheme.ember)
                .frame(width: 52, height: 52).background(HyggeTheme.peach, in: RoundedRectangle(cornerRadius: 18)).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                // A question truncated is a question lost: wrap fully.
                Text(title).font(.system(.headline, design: .rounded, weight: .semibold)).foregroundStyle(HyggeTheme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text(subtitle).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }.frame(maxWidth: .infinity, alignment: .leading)
            arrow
        }.padding(18)
    }
    private func earnings(_ amount: Double, _ currency: String) -> some View {
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                eyebrow("YOURS, EARNED")
                // Never shrink money below the user's chosen size:
                // it wraps to a second line instead.
                Text(JournalBuilder.money(amount, currencyCode: currency))
                    .font(.system(.largeTitle, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text(subtitle).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }.frame(maxWidth: .infinity, alignment: .leading)
            if !typeSize.isAccessibilitySize {
                Image("SettingsEarnings").resizable().scaledToFit().scaleEffect(1.5)
                    .frame(width: 110, height: 110).accessibilityHidden(true)
            }
            arrow
        }.padding(20).background(HyggeTheme.butterTint.opacity(0.45))
    }
    private var celebration: some View {
        HStack(alignment: .top, spacing: 16) {
            Image(systemName: "checkmark.seal.fill").font(.system(size: 42)).foregroundStyle(HyggeTheme.sageDeep).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.system(.headline, design: .rounded, weight: .semibold)).foregroundStyle(HyggeTheme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text(subtitle).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }.frame(maxWidth: .infinity, alignment: .leading)
            arrow
        }.padding(20).background(HyggeTheme.sageTint.opacity(0.35))
    }
    private var update: some View {
        FeedSummary(title: title, subtitle: subtitle, icon: icon, asset: asset, usesProfilePhoto: usesProfilePhoto,
                    siteDomain: siteDomain, siteName: siteName)
    }
    private var arrow: some View {
        Image(systemName: "arrow.up.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(HyggeTheme.secondary).accessibilityHidden(true)
    }
    private func eyebrow(_ text: String) -> some View {
        Text(text).font(.system(.caption2, design: .rounded, weight: .bold)).tracking(1.1).foregroundStyle(HyggeTheme.secondary)
    }
}
