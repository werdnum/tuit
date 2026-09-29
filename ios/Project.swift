import ProjectDescription

let team = "H7NBC2S52X"

let project = Project(
    name: "Tuit",
    options: .options(automaticSchemesOptions: .enabled(), developmentRegion: "en"),
    settings: .settings(base: [
        "DEVELOPMENT_TEAM": .string(team),
        "SWIFT_VERSION": "6.0",
        "SWIFT_DEFAULT_ACTOR_ISOLATION": "MainActor",
        "SWIFT_APPROACHABLE_CONCURRENCY": "YES",
        "CODE_SIGN_STYLE": "Automatic",
    ]),
    targets: [
        .target(
            name: "Tuit",
            destinations: [.iPhone, .iPad],
            product: .app,
            bundleId: "dev.andrewgarrett.tuit",
            deploymentTargets: .iOS("17.0"),
            infoPlist: .extendingDefault(with: [
                "CFBundleDisplayName": "Tuit",
                "CFBundleShortVersionString": "1.0",
                "CFBundleVersion": "1",
                "UILaunchScreen": ["UIColorName": "LaunchBackground"],
                "UISupportedInterfaceOrientations": ["UIInterfaceOrientationPortrait"],
                "UISupportedInterfaceOrientations~ipad": [
                    "UIInterfaceOrientationPortrait",
                    "UIInterfaceOrientationPortraitUpsideDown",
                    "UIInterfaceOrientationLandscapeLeft",
                    "UIInterfaceOrientationLandscapeRight",
                ],
                // Only for a server on your own Mac while developing (npm run local).
                "NSAppTransportSecurity": ["NSAllowsLocalNetworking": true],
                "ITSAppUsesNonExemptEncryption": false,
                "CFBundleURLTypes": [["CFBundleURLName": "dev.andrewgarrett.tuit", "CFBundleURLSchemes": ["tuit"]]],
            ]),
            sources: ["Tuit/Sources/**"],
            resources: ["Tuit/Resources/**"]
        ),
        .target(
            name: "TuitTests",
            destinations: [.iPhone, .iPad],
            product: .unitTests,
            bundleId: "dev.andrewgarrett.tuit.tests",
            deploymentTargets: .iOS("17.0"),
            infoPlist: .default,
            sources: ["TuitTests/**"],
            dependencies: [.target(name: "Tuit")]
        ),
    ]
)
