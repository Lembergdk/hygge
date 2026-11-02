import SwiftUI
import UIKit

/// Shared settings surfaces use the app's appearance-aware palette.
struct SettingsPage<Content: View>: View {
    let title: String
    @ViewBuilder var content: () -> Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24, content: content)
                .padding(22).padding(.bottom, 20)
        }
        .background(HyggeTheme.paper)
        .toolbar(.visible, for: .navigationBar)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(HyggeTheme.paper, for: .navigationBar)
        .tint(HyggeTheme.sageDeep)
        .fontDesign(.rounded)
    }
}

struct SettingsArtwork: View {
    let name: String
    var width: CGFloat = 140
    var height: CGFloat = 120
    var body: some View {
        Image(name).resizable().scaledToFit().frame(width: width, height: height)
            .accessibilityHidden(true)
    }
}

struct SettingsIntro: View {
    let title: String
    let artwork: String
    var body: some View {
        HStack(spacing: 10) {
            Text(title).font(.system(.title2, design: .rounded, weight: .bold))
                .foregroundStyle(HyggeTheme.ink).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            SettingsArtwork(name: artwork, width: 100, height: 105)
        }
    }
}

struct SettingsRow: View {
    let title: String
    let icon: String
    var detail: String? = nil
    var subtitle: String? = nil
    var destructive = false
    var chevron = true
    var body: some View {
        HStack(spacing: 16) {
            Image(systemName: icon).font(.system(size: 23, weight: .regular))
                .frame(width: 28).foregroundStyle(destructive ? HyggeTheme.emberDeep : HyggeTheme.secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.body).foregroundStyle(destructive ? HyggeTheme.emberDeep : HyggeTheme.ink)
                if let subtitle { Text(subtitle).font(.caption).foregroundStyle(HyggeTheme.secondary) }
            }
            Spacer(minLength: 8)
            if let detail { Text(detail).font(.subheadline).foregroundStyle(HyggeTheme.secondary) }
            if chevron { Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(HyggeTheme.secondary) }
        }
        .padding(.vertical, 18).frame(minHeight: 60).contentShape(Rectangle())
    }
}

struct SettingsActionStyle: ButtonStyle {
    var filled = true
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.body.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 48)
            .padding(.horizontal, 12)
            .foregroundStyle(filled ? HyggeTheme.onSage : HyggeTheme.sageDeep)
            .background(filled ? HyggeTheme.sageDeep : .clear, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(HyggeTheme.sageDeep, lineWidth: filled ? 0 : 1))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

extension View {
    func settingsField() -> some View {
        padding(14).frame(minHeight: 48)
            .background(HyggeTheme.card.opacity(0.5), in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(HyggeTheme.hairline))
            .foregroundStyle(HyggeTheme.ink)
    }
    func settingsSurface() -> some View {
        padding(16).background(HyggeTheme.card, in: RoundedRectangle(cornerRadius: 22))
    }
}

struct ProfileAvatar: View {
    @Environment(AppStore.self) private var store
    var size: CGFloat = 72
    var body: some View {
        Group {
            if let data = store.profilePhotoData, let photo = UIImage(data: data) {
                Image(uiImage: photo).resizable().scaledToFill()
            } else {
                ZStack {
                    HyggeTheme.sageTint
                    Image(systemName: "person.fill").font(.system(size: size * 0.42)).foregroundStyle(HyggeTheme.sageDeep)
                }
            }
        }
        .frame(width: size, height: size).clipShape(Circle()).accessibilityLabel("Profile photo")
    }
}
