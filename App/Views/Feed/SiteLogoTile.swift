import SwiftUI

/// A job site's real mark in a tile: the site's own touch icon,
/// then its favicon, then a quiet letter tile. Logos are small,
/// rounded, and never load from a third-party favicon service.
struct SiteLogoTile: View {
    let domain: String
    let name: String
    var size: CGFloat = 56

    @State private var attempt = 0

    private var candidates: [URL] { SiteIcon.candidateURLs(domain: domain) }
    private var radius: CGFloat { size * 0.24 }

    var body: some View {
        TileBox(size: size, radius: radius) {
            if attempt < candidates.count {
                AsyncImage(url: candidates[attempt]) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    case .failure:
                        // Advance to the next candidate, then the letter.
                        Color.clear.onAppear { attempt += 1 }
                    default:
                        monogram
                    }
                }
            } else {
                monogram
            }
        }
        .accessibilityHidden(true)
    }

    private var monogram: some View {
        ZStack {
            HyggeTheme.sageTint
            Text(SiteIcon.monogram(for: name))
                .font(.system(size: size * 0.42, weight: .bold, design: .rounded))
                .foregroundStyle(HyggeTheme.sageDeep)
        }
    }
}

private struct TileBox<Content: View>: View {
    let size: CGFloat
    let radius: CGFloat
    @ViewBuilder var content: Content

    var body: some View {
        content
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).stroke(HyggeTheme.hairline, lineWidth: 1))
    }
}
