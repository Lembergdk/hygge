import SwiftUI

/// Shared field; visibility is local and secrets never enter persistent app state.
struct AccountPasswordField: View {
    let title: String
    @Binding var password: String
    var isNew = true
    @State private var visible = false
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 12) {
            Group {
                if visible { TextField(title, text: $password) }
                else { SecureField(title, text: $password) }
            }
            .textContentType(isNew ? .newPassword : .password)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .focused($focused).accessibilityLabel(title)
            Button {
                visible.toggle()
                focused = true
            } label: {
                Image(systemName: visible ? "eye.slash" : "eye")
                    .foregroundStyle(HyggeTheme.secondary).frame(width: 36, height: 32)
            }.buttonStyle(.plain).accessibilityLabel(visible ? "Hide password" : "Show password")
        }.settingsField()
    }
}
