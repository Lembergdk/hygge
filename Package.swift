// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Hygge",
    platforms: [.macOS(.v13), .iOS(.v17)],
    products: [
        .library(name: "HyggeCore", targets: ["HyggeCore"])
    ],
    targets: [
        .target(name: "HyggeCore"),
        .testTarget(name: "HyggeCoreTests", dependencies: ["HyggeCore"])
    ]
)
