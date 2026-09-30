import ProjectDescription

let team = "H7NBC2S52X"
/// The household's server. Browser sign-in only works for a host listed in the app's associated
/// domains, whose apple-app-site-association names this app (TUIT_IOS_APP_IDS on the server).
let host = "tuit.andrewgarrett.dev"

let project = Project(
    name: "Tuit",
    options: .options(automaticSchemesOptions: .enabled(), developmentRegion: "en"),
    settings: .settings(base: [
        "DEVELOPMENT_TEAM": .string(team),
        "SWIFT_VERSION": "6.0",
        "SWIFT_DEFAULT_ACTOR_ISOLATION": "MainActor",
        "SWIFT_APPROACHABLE_CONCURRENCY": "YES",
        "CODE_SIGN_STYLE": "Automatic",
        "MARKETING_VERSION": "1.0",
        // Xcode Cloud stamps its own build number when it exports for TestFlight.
        "CURRENT_PROJECT_VERSION": "1",
    ]),
    targets: [
        .target(
            name: "Tuit",
            destinations: [.iPhone, .iPad],
            product: .app,
            bundleId: "dev.andrewgarrett.tuit",
            deploymentTargets: .iOS("17.4"),
            infoPlist: .extendingDefault(with: [
                "CFBundleDisplayName": "Tuit",
                "CFBundleShortVersionString": "$(MARKETING_VERSION)",
                "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)",
                "TuitServer": .string("https://\(host)"),
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
            resources: ["Tuit/Resources/**"],
            entitlements: .dictionary([
                "com.apple.developer.associated-domains": .array([
                    .string("applinks:\(host)"),
                    .string("webcredentials:\(host)"),
                ]),
            ])
        ),
        .target(
            name: "TuitTests",
            destinations: [.iPhone, .iPad],
            product: .unitTests,
            bundleId: "dev.andrewgarrett.tuit.tests",
            deploymentTargets: .iOS("17.4"),
            infoPlist: .default,
            sources: ["TuitTests/**"],
            dependencies: [.target(name: "Tuit")]
        ),
    ]
)
