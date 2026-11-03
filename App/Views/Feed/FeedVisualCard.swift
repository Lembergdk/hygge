import SwiftUI

/// Different stories deserve different compositions, not a stack of identical rows.
enum FeedCardStyle {
    case invitation, opportunity, review, question, earnings(Double, String), celebration, update
}

struct FeedVisualCard: View {
    @Environment(AppStore.self) private var store
    let style: FeedCardStyle
    let title: String
    let subtitle: String
    let icon: String
    var asset: String?
    var usesProfilePhoto = false
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
    private var invitation: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 7) {
                    eyebrow("A NEW PLACE")
                    Text(title).font(.system(.title2, design: .rounded, weight: .bold))
                    Text(subtitle).font(.subheadline).foregroundStyle(HyggeTheme.secondary).lineLimit(2)
                }.frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "globe.europe.africa.fill")
                    .font(.system(size: 48, weight: .light)).foregroundStyle(HyggeTheme.sageDeep)
                    .rotationEffect(.degrees(-12)).frame(width: 64, height: 64)
                    .background(HyggeTheme.sageTint, in: RoundedRectangle(cornerRadius: 20))
                    .accessibilityHidden(true)
            }
            HStack(spacing: 9) {
                Image(systemName: "person.crop.circle.badge.plus")
                Image(systemName: "arrow.right").font(.caption2)
                Image(systemName: "person.text.rectangle")
                Image(systemName: "arrow.right").font(.caption2)
                Image(systemName: "briefcase")
                Spacer()
                arrow
            }.foregroundStyle(HyggeTheme.sageDeep).accessibilityHidden(true)
        }.foregroundStyle(HyggeTheme.ink).padding(20)
    }
    private var opportunity: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 8) {
                    eyebrow("FOUND FOR YOU")
                    Image(systemName: "sparkle").font(.title2).foregroundStyle(HyggeTheme.butterText)
                }
                Spacer()
                Image(systemName: icon).font(.system(size: 68, weight: .light))
                    .foregroundStyle(HyggeTheme.butterText).rotationEffect(.degrees(-12)).accessibilityHidden(true)
            }.padding(.horizontal, 22).padding(.vertical, 18)
                .background(HyggeTheme.butterTint)
            VStack(alignment: .leading, spacing: 14) {
                Text(title).font(.system(.title3, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink).lineLimit(2)
                HStack {
                    Text(subtitle).font(.subheadline.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep).lineLimit(2)
                    Spacer(minLength: 10)
                    arrow
                }
            }.padding(20)
        }
    }
    private var review: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                if usesProfilePhoto { ProfileAvatar(size: 60).accessibilityHidden(true) }
                else {
                    Image(systemName: icon).font(.system(size: 38, weight: .light)).foregroundStyle(HyggeTheme.butterText)
                        .frame(width: 60, height: 60).background(HyggeTheme.butterTint, in: RoundedRectangle(cornerRadius: 18)).accessibilityHidden(true)
                }
                Spacer()
                Text("FOR YOUR OK").font(.caption2.weight(.bold)).foregroundStyle(HyggeTheme.butterText)
                    .padding(.horizontal, 10).padding(.vertical, 7).background(HyggeTheme.butterTint, in: Capsule())
            }
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.system(.title3, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink).lineLimit(2)
                HStack {
                    Text(subtitle).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                    Spacer()
                    arrow
                }
            }
        }.padding(20)
    }
    private var question: some View {
        HStack(spacing: 16) {
            Image(systemName: icon).font(.system(size: 28, weight: .medium)).foregroundStyle(HyggeTheme.ember)
                .frame(width: 52, height: 52).background(HyggeTheme.peach, in: RoundedRectangle(cornerRadius: 18)).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.system(.headline, design: .rounded, weight: .semibold)).foregroundStyle(HyggeTheme.ink).lineLimit(2)
                Text(subtitle).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading)
            arrow
        }.padding(18)
    }
    private func earnings(_ amount: Double, _ currency: String) -> some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                eyebrow("YOURS, EARNED")
                Text(JournalBuilder.money(amount, currencyCode: currency))
                    .font(.system(.largeTitle, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                    .minimumScaleFactor(0.7).lineLimit(1)
                Text(subtitle).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading)
            Image("SettingsEarnings").resizable().scaledToFit().scaleEffect(1.5)
                .frame(width: 110, height: 110).accessibilityHidden(true)
            arrow
        }.padding(20).background(HyggeTheme.butterTint.opacity(0.45))
    }
    private var celebration: some View {
        HStack(spacing: 16) {
            Image(systemName: "checkmark.seal.fill").font(.system(size: 42)).foregroundStyle(HyggeTheme.sageDeep).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.system(.headline, design: .rounded, weight: .semibold)).foregroundStyle(HyggeTheme.ink).lineLimit(2)
                Text(subtitle).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading)
            arrow
        }.padding(20).background(HyggeTheme.sageTint.opacity(0.35))
    }
    private var update: some View {
        FeedSummary(title: title, subtitle: subtitle, icon: icon, asset: asset, usesProfilePhoto: usesProfilePhoto)
    }
    private var arrow: some View {
        Image(systemName: "arrow.up.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(HyggeTheme.secondary).accessibilityHidden(true)
    }
    private func eyebrow(_ text: String) -> some View {
        Text(text).font(.system(.caption2, design: .rounded, weight: .bold)).tracking(1.1).foregroundStyle(HyggeTheme.secondary)
    }
}
