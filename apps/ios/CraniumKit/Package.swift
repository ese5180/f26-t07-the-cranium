// swift-tools-version:6.0
//
// The logic of the Cranium iPhone app, kept apart from the app so that it builds and its tests
// run with `swift test` on a Mac that has no Xcode.
//
//   CraniumKit   configuration, sign-in, the console API, image checks, the update flow
//   CraniumBLE   Bluetooth: scanning, pairing, and MCUmgr's image list and upload
//
// See docs/mobile-apps.md for the contract both of them follow.

import PackageDescription

let package = Package(
    name: "CraniumKit",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "CraniumKit", targets: ["CraniumKit"]),
        .library(name: "CraniumBLE", targets: ["CraniumBLE"]),
    ],
    dependencies: [
        // Nordic's nRF Connect Device Manager library. Pinned: an update can change which
        // commands an upload sends, and the board refuses anything but image list and upload.
        .package(
            url: "https://github.com/NordicSemiconductor/IOS-nRF-Connect-Device-Manager.git",
            exact: "1.15.0"
        ),
    ],
    targets: [
        // Swift 6 language mode: complete data-race checking.
        .target(name: "CraniumKit"),
        // Swift 5 mode: CoreBluetooth's delegates and the library's types are not Sendable. This
        // target keeps all its state on the main queue instead (see McuMgrBoardTransport).
        .target(
            name: "CraniumBLE",
            dependencies: [
                "CraniumKit",
                .product(name: "iOSMcuManagerLibrary", package: "IOS-nRF-Connect-Device-Manager"),
            ],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "CraniumKitTests",
            dependencies: ["CraniumKit"]
        ),
        .testTarget(
            name: "CraniumBLETests",
            dependencies: [
                "CraniumBLE",
                "CraniumKit",
                .product(name: "iOSMcuManagerLibrary", package: "IOS-nRF-Connect-Device-Manager"),
            ]
        ),
    ]
)
