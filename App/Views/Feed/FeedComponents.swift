import SwiftUI

struct FeedSummary: View {
    let title: String
    let subtitle: String
    var icon = "sparkles"
    var asset: String? = nil
    var usesProfilePhoto = false
    /// When set (and no photo/asset claims the tile), the tile is
    /// the site's own mark — sender/site recognition at a glance.
    var siteDomain: String? = nil
    var siteName: String? = nil
    @Environment(AppStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .headline) private var tileSize: CGFloat = 48
    var body: some View {
        // Side-by-side until accessibility sizes, where the tile
        // moves to its own line and text gets the full width.
        // (ViewThatFits cannot judge this: flexible text reports
        // a small ideal size and always "fits".)
        Group {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 10) {
                    tile
                    textBlock
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                row
            }
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading).hyggeCard(radius: 22)
    }
    private var row: some View {
        HStack(alignment: .top, spacing: 13) {
            tile
            textBlock
            Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold))
                .foregroundStyle(HyggeTheme.secondary).accessibilityHidden(true)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private var tile: some View {
        Group {
            if usesProfilePhoto, store.profilePhotoData != nil {
                ProfileAvatar(size: 48)
            } else if let siteDomain, asset == nil {
                SiteLogoTile(domain: siteDomain, name: siteName ?? title, size: 48)
            } else if let asset {
                Image(asset).resizable().scaledToFit().scaleEffect(1.7)
            } else if icon == "checkmark.circle.fill" {
                Image(systemName: icon).font(.system(size: 32)).foregroundStyle(HyggeTheme.sageDeep)
            } else {
                Image(systemName: icon).font(.system(size: 23, weight: .medium))
                    .foregroundStyle(HyggeTheme.sageDeep)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(HyggeTheme.sageTint, in: RoundedRectangle(cornerRadius: 13))
            }
        }
        // The tile grows a little with type, then yields: past
        // accessibility sizes ViewThatFits has already restacked.
        .frame(width: min(tileSize, 60), height: min(tileSize, 60))
        .accessibilityHidden(true)
    }
    private var textBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(.headline, design: .rounded, weight: .semibold))
                .foregroundStyle(HyggeTheme.ink).lineLimit(2)
            if !subtitle.isEmpty {
                // Subtitles carry foreign content (pay, place, sender):
                // wrap fully, never truncate the only copy.
                Text(subtitle).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Scrolling detail body with an optional pinned footer: the one
/// primary action (and any quiet secondary) lives outside the
/// scroll view, so it can never fall below the fold at large
/// Dynamic Type sizes. Surfaces without a footer keep the old
/// single-argument form via the extension below.
struct FeedDetailContent<Content: View, Footer: View>: View {
    @ViewBuilder var content: Content
    @ViewBuilder var footer: Footer
    var body: some View {
        ViewThatFits(in: .vertical) {
            // Ask the complete body + footer for their natural height first.
            // A flexible ScrollView alone would always consume the card's cap.
            VStack(spacing: 0) {
                detailBody
                pinnedFooter
            }
            .fixedSize(horizontal: false, vertical: true)

            VStack(spacing: 0) {
                ScrollView { detailBody }
                    .scrollBounceBehavior(.basedOnSize, axes: .vertical)
                pinnedFooter
            }
        }
        .background(HyggeTheme.card)
    }
    private var detailBody: some View {
        VStack(alignment: .leading, spacing: 24) { content }
            .padding(.horizontal, 24).padding(.top, 4).padding(.bottom, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
    @ViewBuilder private var pinnedFooter: some View {
        if ObjectIdentifier(Footer.self) != ObjectIdentifier(EmptyView.self) {
            VStack(spacing: 2) { footer }
                .padding(.horizontal, 24)
                .padding(.top, 12).padding(.bottom, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(HyggeTheme.card)
                .overlay(alignment: .top) {
                    Rectangle().fill(HyggeTheme.hairline).frame(height: 1)
                }
        }
    }
}

extension FeedDetailContent where Footer == EmptyView {
    init(@ViewBuilder content: () -> Content) {
        self.init(content: content) { EmptyView() }
    }
}

struct FeedPrimaryButton: View {
    let title: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).font(.system(.body, design: .rounded, weight: .semibold))
                // A primary action never renders below default
                // body size, however small the user's setting;
                // above that it scales with them as usual.
                .dynamicTypeSize(.large...)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity).frame(minHeight: 44).padding(.vertical, 8)
                .foregroundStyle(HyggeTheme.onSage).background(HyggeTheme.sageDeep, in: Capsule())
        }.buttonStyle(.plain)
    }
}

/// One fact, the same at every Dynamic Type size: icon + label on
/// one line (the label can never character-break), value below at
/// full width. No fixed-width text columns, no size-threshold
/// layout flip — the previous two-column form shattered its
/// 58 pt label column from `.xLarge` upward.
struct FeedFact: View {
    let icon: String
    let title: String
    let value: String
    @ScaledMetric(relativeTo: .subheadline) private var iconWidth: CGFloat = 22
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .center, spacing: 8) {
                Image(systemName: icon)
                    .font(.subheadline)
                    .frame(width: iconWidth)
                    .foregroundStyle(HyggeTheme.sageDeep)
                    .accessibilityHidden(true)
                Text(title)
                    .font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.ink)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
            }
            Text(value)
                .font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
