import SwiftUI

struct EmailFeedCard: View {
    let mail: FiledEmailSummary
    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(spacing: 9) {
                SiteLogoTile(domain: mail.senderDomain, name: mail.senderDomain, size: 30)
                Text(mail.senderAddress).font(.caption.weight(.semibold)).lineLimit(2)
                Spacer(minLength: 0)
                if let date = mail.receivedAt {
                    Text(date, style: .time).font(.caption).foregroundStyle(HyggeTheme.secondary)
                }
                Image(systemName: "envelope").font(.caption).foregroundStyle(HyggeTheme.secondary)
            }
            Text(mail.displayTitle).font(.system(.title3, design: .rounded, weight: .bold))
                .fixedSize(horizontal: false, vertical: true)
            Text(mail.summary).font(.subheadline).foregroundStyle(HyggeTheme.secondary).lineLimit(2)
            HStack {
                Text(
                    mail.markedAsMe == true || mail.relation == "owner"
                        ? "From you" : "Email summary"
                ).font(.caption).foregroundStyle(HyggeTheme.secondary)
                Spacer()
                Image(systemName: "arrow.up.right").font(.caption.weight(.semibold))
                    .foregroundStyle(HyggeTheme.sageDeep)
            }
        }.padding(18).foregroundStyle(HyggeTheme.ink)
            .background(HyggeTheme.card, in: RoundedRectangle(cornerRadius: 24))
            .overlay(RoundedRectangle(cornerRadius: 24).stroke(HyggeTheme.hairline))
            .accessibilityElement(children: .combine)
    }
}

struct EmailHistoryRow: View {
    let mail: FiledEmailSummary
    @Environment(AppStore.self) private var store
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            SiteLogoTile(domain: mail.senderDomain, name: mail.senderDomain, size: 36)
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top) {
                    Text(mail.senderAddress).font(.caption.weight(.semibold)).fixedSize(
                        horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    if let date = mail.receivedAt {
                        Text(date, style: .time).font(.caption).foregroundStyle(
                            HyggeTheme.secondary)
                    }
                }
                Text(mail.displayTitle).font(.subheadline.weight(.semibold)).fixedSize(
                    horizontal: false, vertical: true)
                Text(mail.summary).font(.caption).foregroundStyle(HyggeTheme.secondary).lineLimit(2)
                if mail.markedAsMe == true || mail.relation == "owner" {
                    Label("From you", systemImage: "person.crop.circle").font(.caption)
                        .foregroundStyle(HyggeTheme.secondary)
                }
                if store.ignoredSenderDomains.contains(mail.senderDomain) {
                    Label("Ignored", systemImage: "bell.slash").font(.caption).foregroundStyle(
                        HyggeTheme.secondary)
                }
            }
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(HyggeTheme.secondary)
                .padding(.top, 3)
        }.foregroundStyle(HyggeTheme.ink).padding(.vertical, 16)
    }
}

struct EmailRefreshStatus: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        if let error = store.emailRefreshError {
            Label(error, systemImage: "wifi.slash").font(.subheadline).foregroundStyle(
                HyggeTheme.secondary)
            Button("Try again") { Task { await store.refreshHyggeEmail() } }.foregroundStyle(
                HyggeTheme.sageDeep)
        } else if store.refreshingEmail {
            ProgressView("Refreshing email…").tint(HyggeTheme.sageDeep)
        }
    }
}

struct EmailHistoryView: View {
    @Environment(AppStore.self) private var store
    private var days: [Date] {
        Array(
            Set(
                store.filedEmailSummaries.map { mail in
                    mail.receivedAt.map { Calendar.current.startOfDay(for: $0) } ?? .distantPast
                })
        ).sorted(by: >)
    }
    private func label(_ date: Date) -> String {
        if date == .distantPast { return "Date unavailable" }
        if Calendar.current.isDateInToday(date) { return "Today" }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(date: .abbreviated, time: .omitted)
    }
    var body: some View {
        SettingsPage(title: "Email history") {
            EmailRefreshStatus()
            if store.filedEmailSummaries.isEmpty && store.emailHasLoaded
                && store.emailRefreshError == nil
            {
                VStack(spacing: 18) {
                    SettingsArtwork(name: "SettingsEmail", width: 135, height: 120)
                    Text("No email received yet").font(.title2.bold())
                    Text(
                        "Forward work-site mail to your Hygge address. Its summaries will appear here."
                    )
                    .multilineTextAlignment(.center).foregroundStyle(HyggeTheme.secondary)
                    if let address = store.hyggeEmailAddress {
                        Text(address.address).font(.subheadline.weight(.semibold)).textSelection(
                            .enabled)
                        Button("Copy email address") {
                            UIPasteboard.general.string = address.address
                        }.buttonStyle(SettingsActionStyle())
                    }
                }.frame(maxWidth: .infinity).padding(.top, 32)
            } else {
                ForEach(days, id: \.self) { day in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(label(day)).font(.subheadline.weight(.semibold)).foregroundStyle(
                            HyggeTheme.secondary)
                        VStack(spacing: 0) {
                            let messages = store.filedEmailSummaries.filter {
                                ($0.receivedAt.map { Calendar.current.startOfDay(for: $0) }
                                    ?? .distantPast) == day
                            }
                            ForEach(messages) { mail in
                                NavigationLink {
                                    FiledEmailDetailView(mail: mail)
                                } label: {
                                    EmailHistoryRow(mail: mail)
                                }.buttonStyle(.plain)
                                if mail.id != messages.last?.id { Divider() }
                            }
                        }.settingsSurface()
                    }
                }
                if store.emailNextCursor != nil {
                    Button {
                        Task { await store.loadOlderEmail() }
                    } label: {
                        if store.loadingOlderEmail {
                            ProgressView()
                        } else {
                            Text("Load older email")
                        }
                    }.buttonStyle(SettingsActionStyle(filled: false)).disabled(
                        store.loadingOlderEmail || store.refreshingEmail)
                }
            }
        }.task { await store.refreshHyggeEmail() }.refreshable { await store.refreshHyggeEmail() }
    }
}
