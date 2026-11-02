import SwiftUI

struct ProfileHubView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var signingOut = false
    @State private var confirmSignOut = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    profileHeader
                    preferences
                    insights
                    VStack(spacing: 0) {
                        NavigationLink { SettingsLoginsView() } label: {
                            SettingsRow(title: "Your logins", icon: "key")
                        }
                        Divider()
                        NavigationLink { ApprovedSitesView() } label: {
                            SettingsRow(title: "Approved sites", icon: "link", detail: "\(store.approvedSettingsSites.count)")
                        }
                        Divider()
                        NavigationLink { SettingsEmailView() } label: {
                            SettingsRow(title: "Hygge email", icon: "envelope", detail: store.hyggeEmailAddress == nil ? "Set up" : "Ready")
                        }
                        Divider()
                        NavigationLink { SettingsPermissionsView() } label: {
                            SettingsRow(title: "Permissions", icon: "slider.horizontal.3", subtitle: "Notifications, calendar & location")
                        }
                        Divider()
                        Button { confirmSignOut = true } label: {
                            SettingsRow(title: signingOut ? "Signing out…" : "Sign out", icon: "rectangle.portrait.and.arrow.right", destructive: true, chevron: false)
                        }.disabled(signingOut)
                    }
                }
                .padding(.horizontal, 22).padding(.top, 22).padding(.bottom, 24)
            }
            .background(HyggeTheme.paper)
            .toolbar(.hidden, for: .navigationBar)
            .fontDesign(.rounded).tint(HyggeTheme.sageDeep)
            .buttonStyle(.plain)
            .confirmationDialog("Sign out of Hygge?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) {
                    signingOut = true
                    Task { await store.signOut(); dismiss() }
                }
            }
            .task { await store.syncProfilePhoto(); await store.refreshSessionProfiles(); await store.refreshHyggeEmail() }
        }
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(28)
    }

    private var profileHeader: some View {
        HStack(spacing: 14) {
            ProfileAvatar()
            VStack(alignment: .leading, spacing: 4) {
                Text(store.profile.displayName.isEmpty ? "Your profile" : store.profile.displayName)
                    .font(.system(.title, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                NavigationLink("Edit profile") { SettingsEditProfileView() }
                    .font(.subheadline.weight(.medium)).foregroundStyle(HyggeTheme.sageDeep).frame(minHeight: 32)
                    .accessibilityIdentifier("settings.editProfile")
            }
            Spacer(minLength: 4)
            NavigationLink { SettingsInviteView() } label: {
                Image(systemName: "gift").font(.title2).foregroundStyle(HyggeTheme.sageDeep).frame(width: 48, height: 48)
                    .background(HyggeTheme.sageTint, in: RoundedRectangle(cornerRadius: 16))
            }.accessibilityLabel("Invite a friend")
        }
    }

    private var preferences: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(store.profile.interests.isEmpty ? "Choose the work you enjoy" : store.profile.interests.map(\.settingsLabel).joined(separator: ", "))
                .font(.headline).foregroundStyle(HyggeTheme.ink)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { preferenceChips }
                VStack(alignment: .leading, spacing: 8) { preferenceChips }
            }
        }
    }

    @ViewBuilder private var preferenceChips: some View {
        chip("\(store.profile.hourlyRateFloor.formatted(.currency(code: "USD").precision(.fractionLength(0...2))))/hr minimum", icon: "dollarsign.circle.fill")
        chip(store.profile.locationLabel.isEmpty ? "Set location" : store.profile.locationLabel, icon: "mappin.circle.fill")
    }
    private func chip(_ text: String, icon: String) -> some View {
        Label(text, systemImage: icon).font(.caption).foregroundStyle(HyggeTheme.secondary)
            .padding(.horizontal, 10).padding(.vertical, 8).background(HyggeTheme.paperDeep, in: Capsule())
    }

    private var insights: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .bottom) {
                Text("A little more for you").font(.system(.title3, design: .rounded, weight: .bold)).foregroundStyle(HyggeTheme.ink)
                Spacer(minLength: 0)
                FlameMark(size: 52)
            }
            HStack(alignment: .top, spacing: 12) {
                metric("Confirmed earnings", value: JournalBuilder.money(store.earningsGross), asset: "SettingsEarnings", tint: HyggeTheme.butterTint)
                metric("Time saved", value: store.timeSavedMinutes == 0 ? "0 min" : TimeSaved.aboutLabel(minutes: store.timeSavedMinutes), asset: "SettingsTime", tint: HyggeTheme.sageTint)
            }
        }
    }
    private func metric(_ label: String, value: String, asset: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Image(asset).resizable().scaledToFit().frame(maxWidth: .infinity).frame(height: 94).accessibilityHidden(true)
            Text(value).font(.system(.title, design: .rounded, weight: .bold)).minimumScaleFactor(0.7)
            Text(label).font(.caption).fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(HyggeTheme.ink).padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(tint, in: RoundedRectangle(cornerRadius: 22))
        .accessibilityElement(children: .combine)
    }
}

extension OpportunityCategory {
    var settingsLabel: String {
        self == .creative ? "Design, writing & video" : tileLabel
    }
}

extension AppStore {
    var approvedSettingsSites: [TargetSite] {
        sites.filter { [.hasAccount, .profileLive, .watching, .joining, .needsVerification, .paused].contains(accountStates[$0.id] ?? .unknown) }
    }
}
