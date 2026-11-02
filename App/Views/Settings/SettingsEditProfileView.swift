import SwiftUI
import PhotosUI
import ImageIO

struct SettingsEditProfileView: View {
    @Environment(AppStore.self) private var store
    @State private var photo: PhotosPickerItem?
    @State private var photoError: String?
    @State private var loadingPhoto = false
    @State private var rate = ""
    @State private var invalidRate = false
    @State private var selectingInterests = false

    var body: some View {
        SettingsPage(title: "Edit profile") {
            HStack(alignment: .center, spacing: 16) {
                PhotosPicker(selection: $photo, matching: .images) {
                    ProfileAvatar(size: 82)
                        .overlay(alignment: .bottomTrailing) {
                            Image(systemName: "camera.fill").font(.body)
                                .foregroundStyle(HyggeTheme.onSage).padding(8)
                                .background(HyggeTheme.sageDeep, in: Circle())
                        }
                }.accessibilityLabel("Change profile photo")
                    .disabled(loadingPhoto)
                VStack(alignment: .leading, spacing: 10) {
                    field("Name", value: binding(\.displayName))
                    field("Location", value: binding(\.locationLabel))
                }
            }
            if loadingPhoto { ProgressView("Loading photo…") }
            if let photoError { Text(photoError).font(.caption).foregroundStyle(HyggeTheme.emberDeep) }
            if let error = store.profilePhotoSyncError {
                Text(error).font(.caption).foregroundStyle(HyggeTheme.secondary)
                Button("Try again") { Task { await store.syncProfilePhoto() } }.font(.caption).frame(minHeight: 44)
            } else if store.profilePhotoNeedsUpload {
                Label(store.isSyncingProfilePhoto ? "Uploading photo…" : "Photo waiting to upload", systemImage: "icloud.and.arrow.up")
                    .font(.caption).foregroundStyle(HyggeTheme.secondary)
            }
            Divider()
            VStack(alignment: .leading, spacing: 12) {
                Text("Work you enjoy").font(.headline).foregroundStyle(HyggeTheme.ink)
                // Adaptive columns wrap at larger accessibility text sizes.
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 135), alignment: .leading)], alignment: .leading, spacing: 8) {
                    ForEach(store.profile.interests) { category in
                        Button {
                            store.editProfile { $0.interests.removeAll { $0 == category } }
                        } label: {
                            HStack { Text(category.tileLabel); Image(systemName: "xmark").font(.caption) }
                                .font(.subheadline).padding(12).frame(maxWidth: .infinity, minHeight: 44)
                                .background(HyggeTheme.sageTint, in: Capsule())
                        }.accessibilityLabel("Remove \(category.tileLabel)")
                    }
                }
                Button { selectingInterests = true } label: { Label("Add interest", systemImage: "plus.circle") }
                    .frame(minHeight: 44)
            }
            Divider()
            VStack(alignment: .leading, spacing: 10) {
                Text("Minimum rate").font(.headline).foregroundStyle(HyggeTheme.ink)
                HStack {
                    Text("$")
                    TextField("25", text: $rate).keyboardType(.decimalPad).accessibilityLabel("Minimum hourly rate")
                        .onChange(of: rate) { _, value in updateRate(value) }
                    Text("/ hour").foregroundStyle(HyggeTheme.secondary)
                }.settingsField()
                Text(invalidRate ? "Enter a valid rate of zero or more." : "I’ll skip work below this rate.")
                    .font(.caption).foregroundStyle(invalidRate ? HyggeTheme.emberDeep : HyggeTheme.secondary)
                syncState
            }
            FlameMark(size: 46).padding(.top, 24)
        }
        .onAppear { rate = store.profile.hourlyRateFloor.formatted(.number.grouping(.never).precision(.fractionLength(0...2))) }
        .task(id: photo) { await loadPhoto() }
        .task { await store.syncProfilePhoto() }
        .sheet(isPresented: $selectingInterests) {
            NavigationStack {
                List(OpportunityCategory.allCases) { category in
                    Button {
                        store.editProfile { profile in
                            if profile.interests.contains(category) { profile.interests.removeAll { $0 == category } }
                            else { profile.interests.append(category) }
                        }
                    } label: {
                        HStack {
                            Text(category.activityLabel)
                            Spacer()
                            if store.profile.interests.contains(category) { Image(systemName: "checkmark") }
                        }
                    }.listRowBackground(HyggeTheme.card)
                }
                .scrollContentBackground(.hidden).background(HyggeTheme.paper)
                .navigationTitle("Work you enjoy").navigationBarTitleDisplayMode(.inline)
            }.tint(HyggeTheme.sageDeep).presentationDragIndicator(.visible)
        }
    }

    private func binding(_ keyPath: WritableKeyPath<EarningsProfile, String>) -> Binding<String> {
        Binding(get: { store.profile[keyPath: keyPath] }, set: { value in store.editProfile { $0[keyPath: keyPath] = value } })
    }
    private func field(_ title: String, value: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(HyggeTheme.ink)
            TextField(title, text: value).settingsField().accessibilityLabel(title)
        }
    }
    private func updateRate(_ value: String) {
        guard let number = ProfileRateInput.parse(value) else {
            invalidRate = true; return
        }
        invalidRate = false
        if number != store.profile.hourlyRateFloor { store.editProfile { $0.hourlyRateFloor = number } }
    }
    @ViewBuilder private var syncState: some View {
        if let error = store.lastSyncError {
            Text(error).font(.caption).foregroundStyle(HyggeTheme.secondary)
            Button("Retry sync") { Task { await store.retryProfileSync() } }.font(.caption).frame(minHeight: 44)
        } else if store.pendingProfileEdit {
            Label(store.isBackendFirst ? "Syncing…" : "Saved on this phone", systemImage: "arrow.triangle.2.circlepath")
                .font(.caption).foregroundStyle(HyggeTheme.secondary)
        } else {
            Label("Saved", systemImage: "checkmark.circle.fill").font(.caption).foregroundStyle(HyggeTheme.sageDeep)
        }
    }
    private func loadPhoto() async {
        guard let photo else { return }
        loadingPhoto = true; photoError = nil
        defer { loadingPhoto = false }
        do {
            guard let data = try await photo.loadTransferable(type: Data.self), !Task.isCancelled,
                  let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceThumbnailMaxPixelSize: 512,
                    kCGImageSourceCreateThumbnailWithTransform: true
                  ] as CFDictionary),
                  let jpeg = UIImage(cgImage: thumbnail).jpegData(compressionQuality: 0.8) else {
                if !Task.isCancelled { photoError = "That photo couldn’t be opened. Try another." }; return
            }
            guard !Task.isCancelled else { return }
            guard jpeg.count <= 512 * 1024 else {
                photoError = "That photo is too large. Try another."; return
            }
            store.setProfilePhoto(jpeg)
        } catch { if !Task.isCancelled { photoError = "That photo couldn’t be loaded. Try again." } }
    }
}
