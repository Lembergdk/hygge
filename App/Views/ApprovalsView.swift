import SwiftUI

struct ApprovalsView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("The browser agent drafts every mission first — goal, target site, and the exact text it may use. It then finds its own way around the live site. Nothing runs until you approve it here.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Waiting for you (\(pending.count))") {
                    if pending.isEmpty { Text("Nothing waiting. Draft a task from an opportunity or a site.").foregroundStyle(.secondary) }
                    ForEach(pending) { task in
                        NavigationLink { TaskDetailView(taskID: task.id) } label: { taskRow(task) }
                    }
                }
                Section("Needs you (\(needsHuman.count))") {
                    ForEach(needsHuman) { task in
                        NavigationLink { TaskDetailView(taskID: task.id) } label: { taskRow(task) }
                    }
                }
                Section("Finished (\(finished.count))") {
                    ForEach(finished) { task in
                        NavigationLink { TaskDetailView(taskID: task.id) } label: { taskRow(task) }
                    }
                }
            }
            .navigationTitle("Approvals")
        }
    }

    private var pending: [AgentTask] { store.tasks.filter { $0.status == .awaitingApproval || $0.status == .approved } }
    private var needsHuman: [AgentTask] { store.tasks.filter { $0.status == .needsHuman } }
    private var finished: [AgentTask] { store.tasks.filter { [.succeeded, .failed, .rejected].contains($0.status) } }

    private func taskRow(_ task: AgentTask) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(task.title).font(.headline)
            Text("\(task.kind.label) • \(store.siteName(id: task.siteID)) (\(task.domain)) • \(task.status.rawValue)")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct TaskDetailView: View {
    @Environment(AppStore.self) private var store
    let taskID: UUID
    @State private var showBrowser = false
    @State private var answers: [String: String] = [:]

    private var task: AgentTask? { store.tasks.first { $0.id == taskID } }

    var body: some View {
        if let task {
            Form {
                Section("Browser goal") {
                    Text(task.goal)
                    Text(task.targetURLString).font(.caption).foregroundStyle(.secondary)
                    let hints = store.siteMemory.hints(domain: task.domain, kind: task.kind.memoryKind)
                    Text(hints.isEmpty
                         ? "No memory for this site yet — the agent explores from the goal alone."
                         : "Memory: \(hints.count) advisory hint(s) from past runs (advice only, never a script).")
                        .font(.footnote).foregroundStyle(.secondary)
                    if let credentialID = task.credentialRefID,
                       let credential = store.credentialRefs.first(where: { $0.id == credentialID }) {
                        Text("Login: vault credential \(credential.username) for \(credential.domain) — secret stays server-side.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section("Draft — edit before approving") {
                    if task.draftedPayload.isEmpty { Text("No typed content in this task.").foregroundStyle(.secondary) }
                    ForEach(task.draftedPayload.keys.sorted(), id: \.self) { key in
                        Text(key).font(.caption).foregroundStyle(.secondary)
                        TextEditor(text: payloadBinding(taskID: task.id, key: key))
                            .frame(minHeight: 90)
                    }
                }
                if !task.informationRequests.isEmpty {
                    Section("The agent needs this from you") {
                        ForEach(task.informationRequests, id: \.self) { question in
                            Text(question).font(.callout)
                            TextField("Your answer", text: Binding(
                                get: { answers[question] ?? "" },
                                set: { answers[question] = $0 }))
                        }
                        Button("Send answers (mission goes back for approval)") {
                            store.answerInformation(taskID: task.id, answers: answers)
                        }
                        .disabled(task.informationRequests.contains { (answers[$0] ?? "").isEmpty })
                    }
                }
                if task.status == .awaitingApproval || task.status == .needsHuman {
                    Section {
                        Button("Approve & run in cloud browser") {
                            Task { await store.approveAndRun(taskID: task.id) }
                        }
                        .buttonStyle(.borderedProminent)
                        Button("Reject", role: .destructive) { store.reject(taskID: task.id) }
                    }
                }
                Section {
                    Button("Open this site in the cloud browser") { showBrowser = true }
                }
                if !task.browserTrace.isEmpty {
                    Section("Browser trace (distilled into site memory afterwards)") {
                        ForEach(Array(task.browserTrace.enumerated()), id: \.offset) { _, event in
                            Text("\(event.succeeded ? "✓" : "✗") \(event.action.rawValue): \(event.target) — \(event.summary)")
                                .font(.footnote)
                        }
                    }
                }
                Section("Log") {
                    ForEach(task.log, id: \.self) { line in Text(line).font(.footnote) }
                }
            }
            .navigationTitle(task.title)
            .sheet(isPresented: $showBrowser) {
                NavigationStack {
                    CloudBrowserView(urlString: task.targetURLString)
                        .navigationTitle("Cloud browser")
                }
            }
        } else {
            ContentUnavailableView("Task no longer exists", systemImage: "tray")
        }
    }

    private func payloadBinding(taskID: UUID, key: String) -> Binding<String> {
        Binding(
            get: { store.tasks.first { $0.id == taskID }?.draftedPayload[key] ?? "" },
            set: { store.updatePayload(taskID: taskID, key: key, value: $0) })
    }
}
