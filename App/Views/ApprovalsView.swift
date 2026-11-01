import SwiftUI

struct TaskDetailView: View {
    @Environment(AppStore.self) private var store
    let taskID: UUID
    @State private var showBrowser = false
    @State private var answers: [String: String] = [:]

    private var task: AgentTask? { store.tasks.first { $0.id == taskID } }

    var body: some View {
        if let task {
            Form {
                Section("What Hygge will do") {
                    Text(task.goal)
                    Text(task.targetURLString).font(.caption).foregroundStyle(.secondary)
                    let hints = store.siteMemory.hints(domain: task.domain, kind: task.kind.memoryKind)
                    Text(hints.isEmpty
                         ? "No memory for this site yet — the agent explores from the goal alone."
                         : "Memory: \(hints.count) advisory hint(s) from past runs (advice only, never a script).")
                        .font(.footnote).foregroundStyle(.secondary)
                    if let credentialID = task.credentialRefID,
                       let credential = store.credentialRefs.first(where: { $0.id == credentialID }) {
                        Text("Your login for \(credential.domain) is saved safely — the password itself is never shown.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section("Draft — edit before approving") {
                    if task.draftedPayload.isEmpty { Text("No typed content in this task.").foregroundStyle(.secondary) }
                    ForEach(task.draftedPayload.keys.sorted(), id: \.self) { key in
                        Text(humanLabel(key)).font(.caption).foregroundStyle(.secondary)
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
                        Button("Send answers") {
                            store.answerInformation(taskID: task.id, answers: answers)
                        }
                        .disabled(task.informationRequests.contains { (answers[$0] ?? "").isEmpty })
                    }
                }
                if task.status == .needsHuman && task.informationRequests.isEmpty {
                    Section("A check only you can finish") {
                        Text("This paused at a sign-in check (like a code or \"I'm not a robot\"). Open the browser below, finish the check there, then tap Resume — Hygge carries on in the same place and won't ask for your password again.")
                            .font(.callout)
                        Button("Open the browser to finish the check") { showBrowser = true }
                        Button("Resume — I've finished the check") {
                            Task { await store.approveAndRun(taskID: task.id) }
                        }
                        .buttonStyle(.borderedProminent)
                        Button("Reject", role: .destructive) { store.reject(taskID: task.id) }
                    }
                } else if task.status == .awaitingApproval || task.status == .needsHuman {
                    Section {
                        Button("Approve — go ahead") {
                            Task { await store.approveAndRun(taskID: task.id) }
                        }
                        .buttonStyle(.borderedProminent)
                        Button("Reject", role: .destructive) { store.reject(taskID: task.id) }
                    }
                }
                Section {
                    Button("Watch or take over in the browser") { showBrowser = true }
                }
                if !task.browserTrace.isEmpty {
                    Section("What happened") {
                        ForEach(Array(task.browserTrace.enumerated()), id: \.offset) { _, event in
                            Text("\(event.succeeded ? "✓" : "✗") \(humanize(event.summary))")
                                .font(.footnote)
                        }
                    }
                }
                Section("Why Hygge did this") {
                    ForEach(task.log, id: \.self) { line in Text(humanize(line)).font(.footnote) }
                }
            }
            .navigationTitle(task.title)
            .sheet(isPresented: $showBrowser) {
                NavigationStack {
                    // Reopen the very session that paused, so a finished
                    // check counts when the work resumes.
                    CloudBrowserView(urlString: task.targetURLString,
                                     existingSessionID: task.browserSessionID)
                        .navigationTitle("Browser")
                }
            }
        } else {
            ContentUnavailableView("Task no longer exists", systemImage: "tray")
        }
    }

    private func humanLabel(_ key: String) -> String {
        switch key {
        case "coverLetter": return "Your message"
        case "profileBio": return "Profile text"
        case "profileHeadline": return "Headline"
        case "hourlyRate": return "Hourly rate"
        case "skills": return "Skills"
        case "searchTerms": return "What to look for"
        case "displayName": return "Name"
        case "email": return "Email"
        case "eventTitle": return "Calendar title"
        case "eventStartISO8601": return "When"
        case "location": return "Where"
        default: return key
        }
    }

    /// Render internal log lines in human words; raw traces stay the audit source.
    private func humanize(_ line: String) -> String {
        line
            .replacingOccurrences(of: "simulated local runner", with: "offline mode")
            .replacingOccurrences(of: "Simulated mission complete. Connect the agent service for live LLM browsing.", with: "Finished in offline mode.")
            .replacingOccurrences(of: "Mission on", with: "Working on")
            .replacingOccurrences(of: "Credential injected from the server vault inside the browser worker (secret never shown to the app or model)", with: "Signed in with your saved login (password never shown)")
            .replacingOccurrences(of: "mission actions completed", with: "all done")
    }

    private func payloadBinding(taskID: UUID, key: String) -> Binding<String> {
        Binding(
            get: { store.tasks.first { $0.id == taskID }?.draftedPayload[key] ?? "" },
            set: { store.updatePayload(taskID: taskID, key: key, value: $0) })
    }
}
