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
    @State private var customInterest = ""
    @State private var isLocating = false
    @State private var locationError: String?
    @State private var locationDenied = false

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
                    TextField("Name", text: binding(\.displayName))
                        .textContentType(.name).settingsField().accessibilityLabel("Name")
                    locationField
                }
            }
            if let locationError {
                Text(locationError).font(.caption).foregroundStyle(HyggeTheme.secondary)
                if locationDenied {
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }.font(.caption).frame(minHeight: 44)
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
                        interestChip(category.tileLabel) {
                            store.editProfile { $0.interests.removeAll { $0 == category } }
                        }
                    }
                    ForEach(store.profile.customInterests, id: \.self) { interest in
                        interestChip(interest) {
                            store.editProfile { $0.customInterests.removeAll { $0 == interest } }
                        }
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
            }
            if let error = store.lastSyncError {
                Text(error).font(.caption).foregroundStyle(HyggeTheme.secondary)
                Button("Retry sync") { Task { await store.retryProfileSync() } }.font(.caption).frame(minHeight: 44)
            }
        }
        .onAppear { rate = store.profile.hourlyRateFloor.formatted(.number.grouping(.never).precision(.fractionLength(0...2))) }
        .task(id: photo) { await loadPhoto() }
        .task { await store.syncProfilePhoto() }
        .sheet(isPresented: $selectingInterests) {
            NavigationStack {
                List {
                    Section {
                        HStack {
                            TextField("Add your own interest", text: $customInterest)
                                .accessibilityLabel("Custom interest").submitLabel(.done)
                                .onSubmit(addCustomInterest)
                            Button(action: addCustomInterest) { Image(systemName: "plus.circle.fill") }
                                .frame(minWidth: 44, minHeight: 44).buttonStyle(.borderless)
                                .accessibilityLabel("Add custom interest")
                                .disabled(customInterest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }.listRowBackground(HyggeTheme.card)
                    Section {
                        ForEach(OpportunityCategory.allCases) { category in
                            Button {
                                store.editProfile { profile in
                                    if profile.interests.contains(category) { profile.interests.removeAll { $0 == category } }
                                    else { profile.interests.append(category) }
                                }
                            } label: {
                                HStack {
                                    Text(category.tileLabel)
                                    Spacer()
                                    if store.profile.interests.contains(category) { Image(systemName: "checkmark") }
                                }
                            }.listRowBackground(HyggeTheme.card)
                        }
                    }
                    if !store.profile.customInterests.isEmpty {
                        Section("Your interests") {
                            ForEach(store.profile.customInterests, id: \.self) { interest in
                                HStack {
                                    Text(interest).foregroundStyle(HyggeTheme.ink)
                                    Spacer()
                                    Button {
                                        store.editProfile { $0.customInterests.removeAll { $0 == interest } }
                                    } label: { Image(systemName: "minus.circle") }
                                        .frame(minWidth: 44, minHeight: 44).buttonStyle(.borderless)
                                        .accessibilityLabel("Remove \(interest)")
                                }.listRowBackground(HyggeTheme.card)
                            }
                        }
                    }
                }
                .scrollContentBackground(.hidden).background(HyggeTheme.paper)
                .navigationTitle("Work you enjoy").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { selectingInterests = false } } }
            }.tint(HyggeTheme.sageDeep).presentationDragIndicator(.visible)
        }
    }

    private func binding(_ keyPath: WritableKeyPath<EarningsProfile, String>) -> Binding<String> {
        Binding(get: { store.profile[keyPath: keyPath] }, set: { value in store.editProfile { $0[keyPath: keyPath] = value } })
    }
    private var locationField: some View {
        TextField("Location", text: binding(\.locationLabel))
            .textContentType(.addressCityAndState).accessibilityLabel("Location")
            .padding(.trailing, 36).settingsField()
            .overlay(alignment: .trailing) {
                Button { Task { await useCurrentLocation() } } label: {
                    Group {
                        if isLocating { ProgressView().controlSize(.small) }
                        else { Image(systemName: "location.fill") }
                    }.frame(width: 44, height: 44)
                }.buttonStyle(.plain).foregroundStyle(HyggeTheme.sageDeep)
                    .disabled(isLocating).accessibilityLabel("Use current location")
                    .padding(.trailing, 4)
            }
    }
    private func useCurrentLocation() async {
        guard !isLocating else { return }
        isLocating = true; locationError = nil; locationDenied = false
        defer { isLocating = false }
        // A new service asks for a fresh fix on each tap instead of reusing a cached city.
        let service = LocationService()
        let previousValue = store.profile.locationLabel
        if let label = await service.requestLocality(), !label.isEmpty {
            // Don't replace manual edits made while the location request was running.
            if store.profile.locationLabel == previousValue { store.editProfile { $0.locationLabel = label } }
        } else {
            locationDenied = service.denied
            locationError = service.denied
                ? "Allow location in Settings, or enter your city here."
                : "Couldn't find your location. Try again or enter your city here."
        }
    }
    private func interestChip(_ label: String, remove: @escaping () -> Void) -> some View {
        Button(action: remove) {
            HStack { Text(label).fixedSize(horizontal: false, vertical: true); Image(systemName: "xmark").font(.caption) }
                .font(.subheadline).padding(12).frame(maxWidth: .infinity, minHeight: 44)
                .background(HyggeTheme.sageTint, in: Capsule())
        }.accessibilityLabel("Remove \(label)")
    }
    private func addCustomInterest() {
        var profile = store.profile
        if profile.addCustomInterest(customInterest) {
            store.editProfile { $0 = profile }
        }
        customInterest = ""
    }
    private func updateRate(_ value: String) {
        guard let number = ProfileRateInput.parse(value) else {
            invalidRate = true; return
        }
        invalidRate = false
        if number != store.profile.hourlyRateFloor { store.editProfile { $0.hourlyRateFloor = number } }
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
