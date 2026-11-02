import SwiftUI

struct SettingsLoginsView: View {
    var body: some View {
        SettingsPage(title: "Your logins") {
            SettingsIntro(title: "Your ways back into Hygge.", artwork: "SettingsLogins")
            LoginMethodsContent()
        }
    }
}

struct SettingsInviteView: View {
    @State private var message = "Hygge finds work that fits and handles the boring parts. Thought you might like it."
    @State private var copied = false
    var body: some View {
        SettingsPage(title: "Invite friends") {
            SettingsArtwork(name: "SettingsInvite", width: 180, height: 150).frame(maxWidth: .infinity)
            Text("Good things are better shared.")
                .font(.system(.title, design: .rounded, weight: .bold))
                .foregroundStyle(HyggeTheme.ink).multilineTextAlignment(.center).frame(maxWidth: .infinity)
            Text("Know someone who could use a little less busywork?")
                .foregroundStyle(HyggeTheme.secondary).multilineTextAlignment(.center).frame(maxWidth: .infinity)
            TextField("Invitation message", text: $message, axis: .vertical)
                .lineLimit(3...6).padding(18).foregroundStyle(HyggeTheme.ink)
                .background(HyggeTheme.sageTint, in: RoundedRectangle(cornerRadius: 20))
                .accessibilityLabel("Invitation message")
            HStack {
                Label("usehygge.app", systemImage: "link").foregroundStyle(HyggeTheme.ink)
                Spacer()
                Button(copied ? "Copied" : "Copy link") {
                    UIPasteboard.general.url = URL(string: "https://usehygge.app")
                    copied = true
                }.font(.subheadline).frame(minHeight: 44)
            }.settingsSurface()
            ShareLink(item: "\(message) https://usehygge.app") {
                Label("Share with a friend", systemImage: "square.and.arrow.up")
            }.buttonStyle(SettingsActionStyle())
            Text("Choose who to send it to in the share sheet.")
                .font(.caption).foregroundStyle(HyggeTheme.secondary).frame(maxWidth: .infinity)
        }
    }
}
