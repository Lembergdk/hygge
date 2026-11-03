import SwiftUI

struct FeedSummary: View {
    let title: String
    let subtitle: String
    var icon = "sparkles"
    var asset: String? = nil
    var usesProfilePhoto = false
    @Environment(AppStore.self) private var store
    var body: some View {
        HStack(spacing: 13) {
            Group {
                if usesProfilePhoto, store.profilePhotoData != nil {
                    ProfileAvatar(size: 48)
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
            }.frame(width: 48, height: 48).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(.headline, design: .rounded, weight: .semibold))
                    .foregroundStyle(HyggeTheme.ink).lineLimit(2)
                if !subtitle.isEmpty {
                    Text(subtitle).font(.subheadline).foregroundStyle(HyggeTheme.secondary).lineLimit(2)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold))
                .foregroundStyle(HyggeTheme.secondary).accessibilityHidden(true)
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading).hyggeCard(radius: 22)
    }
}

struct FeedDetailContent<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) { content }
                .padding(24).padding(.top, 16).frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(HyggeTheme.card)
    }
}

struct FeedPrimaryButton: View {
    let title: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).font(.system(.body, design: .rounded, weight: .semibold))
                .frame(maxWidth: .infinity).padding(.vertical, 17)
                .foregroundStyle(HyggeTheme.onSage).background(HyggeTheme.sageDeep, in: Capsule())
        }.buttonStyle(.plain)
    }
}

struct FeedFact: View {
    let icon: String
    let title: String
    let value: String
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).frame(width: 22).foregroundStyle(HyggeTheme.sageDeep)
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 5) {
                    Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.ink)
                    Text(value).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                }
            } else {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.ink)
                    .frame(width: 58, alignment: .leading)
                Text(value).font(.subheadline).foregroundStyle(HyggeTheme.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
