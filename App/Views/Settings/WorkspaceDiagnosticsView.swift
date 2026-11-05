import SwiftUI
import UIKit

/// Owner-only read of the live workspace diagnostics. Shows what is stopping
/// Hygge from starting a new scan, and the full report for copying.
/// The read changes nothing: no dispatch, no retry, no mutation.
struct WorkspaceDiagnosticsView: View {
    @Environment(AppStore.self) private var store
    @State private var phase: Phase = .loading
    @State private var copied = false

    private enum Phase {
        case loading
        case failed
        case loaded(WorkspaceDiagnostics, raw: String)
    }

    var body: some View {
        SettingsPage(title: "Workspace diagnostics") {
            Text("What is stopping Hygge from starting a new scan.")
                .foregroundStyle(HyggeTheme.secondary)
            switch phase {
            case .loading:
                ProgressView().frame(maxWidth: .infinity).padding(.vertical, 32)
            case .failed:
                VStack(alignment: .leading, spacing: 12) {
                    Text("Couldn't load the report.").font(.headline)
                    Text("Check your connection and try again.")
                        .foregroundStyle(HyggeTheme.secondary)
                    Button("Try again") { Task { await load() } }
                        .buttonStyle(SettingsActionStyle())
                }.padding(.vertical, 8)
            case let .loaded(report, raw):
                verdict(report)
                containerSection(report)
                effectsSection(report)
                bindingSection(report)
                tasksSection(report)
                rawSection(raw)
                Button("Check again") { Task { await load() } }
                    .buttonStyle(SettingsActionStyle(filled: false))
            }
        }
        .task { await load() }
    }

    private func load() async {
        phase = .loading
        copied = false
        do {
            let data = try await store.backend.fetchWorkspaceDiagnosticsData()
            let report = try JSONDecoder().decode(WorkspaceDiagnostics.self, from: data)
            let raw = prettyPrinted(data) ?? String(decoding: data, as: UTF8.self)
            phase = .loaded(report, raw: raw)
        } catch {
            phase = .failed
        }
    }

    private func prettyPrinted(_ data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(
                withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
              let text = String(data: pretty, encoding: .utf8) else { return nil }
        return text
    }

    @ViewBuilder
    private func verdict(_ report: WorkspaceDiagnostics) -> some View {
        let blocked = report.wouldBlockNewMission
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: blocked == true ? "exclamationmark.triangle.fill"
                    : (blocked == false ? "checkmark.circle.fill" : "questionmark.circle.fill"))
                    .foregroundStyle(blocked == true ? HyggeTheme.emberDeep
                        : (blocked == false ? HyggeTheme.sageDeep : HyggeTheme.secondary))
                Text(blocked == true ? "Blocked" : (blocked == false ? "Ready" : "Unknown"))
                    .font(.headline)
            }
            if blocked == true {
                Text("Hygge can't start a new scan right now.")
                if let reasons = report.blockReasons, !reasons.isEmpty {
                    ForEach(Array(reasons.enumerated()), id: \.offset) { _, reason in
                        Text("• \(reason)").font(.subheadline)
                            .foregroundStyle(HyggeTheme.secondary)
                    }
                }
            } else if blocked == false {
                Text("Nothing here is stopping a new scan.")
                    .foregroundStyle(HyggeTheme.secondary)
            } else {
                Text("The check itself didn't finish, so this may be incomplete.")
                    .foregroundStyle(HyggeTheme.secondary)
            }
            if let ms = report.ms {
                Text("Checked in \(ms) ms").font(.caption)
                    .foregroundStyle(HyggeTheme.secondary)
            }
        }
        .settingsSurface()
    }

    @ViewBuilder
    private func containerSection(_ report: WorkspaceDiagnostics) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Browser").font(.headline)
            if let container = report.container, container.ok {
                row("Ready", value: (container.initialized ?? false) ? "Yes" : "No")
                row("Frozen", value: (container.frozen ?? false) ? "Yes" : "No")
                row("Held by a person", value: (container.humanControlled ?? false) ? "Yes" : "No")
                if let rev = container.filesystemRevision {
                    row("Files version", value: "\(rev)")
                }
                if let rev = container.browserProfileRevision {
                    row("Browser version", value: "\(rev)")
                }
            } else if let error = report.container?.error {
                Text(error).foregroundStyle(HyggeTheme.secondary)
            } else {
                Text("No browser state came back.").foregroundStyle(HyggeTheme.secondary)
            }
        }
        .settingsSurface()
    }

    @ViewBuilder
    private func effectsSection(_ report: WorkspaceDiagnostics) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Unfinished work").font(.headline)
            if let effects = report.effects {
                if let counts = effects.counts, !counts.isEmpty {
                    ForEach(counts.sorted(by: { $0.key < $1.key }), id: \.key) { key, count in
                        row(key, value: "\(count)")
                    }
                }
                if let unresolved = effects.unresolved, !unresolved.isEmpty {
                    Divider()
                    ForEach(Array(unresolved.enumerated()), id: \.offset) { _, effect in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(short(effect.effectId)).font(.subheadline.weight(.semibold))
                            Text([effect.status, effect.taskId.map(short)]
                                .compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(HyggeTheme.secondary)
                        }.padding(.vertical, 2)
                    }
                } else {
                    Text("Nothing unfinished.").font(.subheadline)
                        .foregroundStyle(HyggeTheme.secondary)
                }
            } else {
                Text("No unfinished-work state came back.")
                    .foregroundStyle(HyggeTheme.secondary)
            }
        }
        .settingsSurface()
    }

    @ViewBuilder
    private func bindingSection(_ report: WorkspaceDiagnostics) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Workspace").font(.headline)
            if let binding = report.binding, binding.ok {
                if let state = binding.lifecycleState { row("State", value: state) }
                if let instance = binding.incarnation { row("Instance", value: instance) }
                if let generation = binding.generation { row("Generation", value: "\(generation)") }
                if let image = binding.desiredImageDigest { row("Image", value: short(image)) }
            } else if let error = report.binding?.error {
                Text(error).foregroundStyle(HyggeTheme.secondary)
            }
            if let lease = report.lease, lease.ok {
                if let expires = lease.expiresAt { row("Lease until", value: expires) }
            }
            if let admission = report.admission {
                row("Something running", value: (admission.runnerOwnerActive ?? false) ? "Yes" : "No")
            }
        }
        .settingsSurface()
    }

    @ViewBuilder
    private func tasksSection(_ report: WorkspaceDiagnostics) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Recent scans").font(.headline)
            if let rows = report.taskRows, !rows.isEmpty {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, task in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(short(task.id)).font(.subheadline.weight(.semibold))
                        Text([task.kind, task.status].compactMap { $0 }
                            .joined(separator: " · "))
                            .font(.caption).foregroundStyle(HyggeTheme.secondary)
                    }.padding(.vertical, 2)
                }
            } else if let error = report.tasksError {
                Text(error).foregroundStyle(HyggeTheme.secondary)
            } else {
                Text("No recent scans.").font(.subheadline)
                    .foregroundStyle(HyggeTheme.secondary)
            }
        }
        .settingsSurface()
    }

    private func rawSection(_ raw: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Full report").font(.headline)
                Spacer()
                Button(copied ? "Copied" : "Copy") {
                    UIPasteboard.general.string = raw
                    copied = true
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(HyggeTheme.sageDeep)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(raw)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(HyggeTheme.ink)
            }
        }
        .settingsSurface()
    }

    private func row(_ label: String, value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(HyggeTheme.secondary)
            Spacer()
            Text(value).foregroundStyle(HyggeTheme.ink)
        }.font(.subheadline)
    }

    private func short(_ value: String?) -> String {
        guard let value, !value.isEmpty else { return "—" }
        return value.count > 12 ? String(value.prefix(12)) + "…" : value
    }
}

/// Lenient model for GET /sandbox/diagnostics. Every section is decoded with
/// try?, so a shape change drops one section instead of the whole report;
/// the raw JSON stays available in the view either way.
struct WorkspaceDiagnostics: Decodable {
    var mode: String?
    var checkedAt: String?
    var workspaceId: String?
    var wouldBlockNewMission: Bool?
    var blockReasons: [String]?
    var ms: Int?
    var ensure: DiagnosticsSection?
    var container: ContainerSection?
    var binding: BindingSection?
    var lease: LeaseSection?
    var admission: AdmissionSection?
    var effects: EffectsSection?
    var taskRows: [DiagnosticTask]?
    var tasksError: String?

    private enum CodingKeys: String, CodingKey {
        case mode, checkedAt, workspaceId, wouldBlockNewMission, blockReasons, ms
        case ensure, container, binding, lease, admission, effects, tasks
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        mode = try? values.decode(String.self, forKey: .mode)
        checkedAt = try? values.decode(String.self, forKey: .checkedAt)
        workspaceId = try? values.decode(String.self, forKey: .workspaceId)
        wouldBlockNewMission = try? values.decode(Bool.self, forKey: .wouldBlockNewMission)
        blockReasons = try? values.decode([String].self, forKey: .blockReasons)
        ms = try? values.decode(Int.self, forKey: .ms)
        ensure = try? values.decode(DiagnosticsSection.self, forKey: .ensure)
        container = try? values.decode(ContainerSection.self, forKey: .container)
        binding = try? values.decode(BindingSection.self, forKey: .binding)
        lease = try? values.decode(LeaseSection.self, forKey: .lease)
        admission = try? values.decode(AdmissionSection.self, forKey: .admission)
        effects = try? values.decode(EffectsSection.self, forKey: .effects)
        taskRows = try? values.decode([DiagnosticTask].self, forKey: .tasks)
        tasksError = (try? values.decode(DiagnosticsSection.self, forKey: .tasks))?.error
    }
}

struct DiagnosticsSection: Decodable {
    var ok: Bool = false
    var ms: Int?
    var error: String?
}

struct ContainerSection: Decodable {
    var ok: Bool = false
    var error: String?
    var initialized: Bool?
    var frozen: Bool?
    var humanControlled: Bool?
    var filesystemRevision: Int?
    var browserProfileRevision: Int?
    var recoveredCheckpointId: String?
}

struct BindingSection: Decodable {
    var ok: Bool = false
    var error: String?
    var lifecycleState: String?
    var incarnation: String?
    var generation: Int?
    var desiredImageDigest: String?
}

struct LeaseSection: Decodable {
    var ok: Bool = false
    var incarnation: String?
    var generation: Int?
    var leaseId: String?
    var expiresAt: String?
}

struct AdmissionSection: Decodable {
    var runnerOwnerActive: Bool?
    var lineagePins: Int?
}

struct EffectsSection: Decodable {
    var counts: [String: Int]?
    var unresolved: [UnresolvedEffect]?
}

struct UnresolvedEffect: Decodable {
    var effectId: String?
    var taskId: String?
    var runId: String?
    var status: String?
    var revision: Int?
    var incarnation: String?
    var generation: Int?
}

struct DiagnosticTask: Decodable {
    var id: String?
    var kind: String?
    var status: String?
    var sessionId: String?
    var helpKind: String?
}
