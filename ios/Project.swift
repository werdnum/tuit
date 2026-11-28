import ProjectDescription

let team = "H7NBC2S52X"
/// The household's server. Browser sign-in only works for a host listed in the app's associated
/// domains, whose apple-app-site-association names this app (TUIT_IOS_APP_IDS on the server).
let host = "tuit.andrewgarrett.dev"
/// The app signs in here as a public PKCE client; the gateway checks its tokens on /api.
let issuer = "https://id.andrewgarrett.dev/realms/master"
let clientId = "tuit-ios"
let appGroup = "group.dev.andrewgarrett.tuit"
let sharedKeychainGroup = "$(AppIdentifierPrefix)dev.andrewgarrett.tuit"

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
                "TuitIssuer": .string(issuer),
                "TuitClientId": .string(clientId),
                "UILaunchScreen": ["UIColorName": "LaunchBackground"],
                "UIBackgroundModes": ["fetch"],
                "BGTaskSchedulerPermittedIdentifiers": ["dev.andrewgarrett.tuit.refresh"],
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
            sources: [
                "Tuit/Sources/**",
                "Shared/Sources/AppGroup.swift",
                "Shared/Sources/WidgetSnapshot.swift",
            ],
            resources: ["Tuit/Resources/**"],
            entitlements: .dictionary([
                // Push notifications. Xcode Cloud's TestFlight export switches this to production.
                "aps-environment": .string("development"),
                "com.apple.developer.associated-domains": .array([
                    .string("applinks:\(host)"),
                    .string("webcredentials:\(host)"),
                ]),
                "com.apple.security.application-groups": .array([
                    .string(appGroup),
                ]),
                "keychain-access-groups": .array([
                    .string(sharedKeychainGroup),
                ]),
            ]),
            dependencies: [
                .target(name: "TuitWidgets"),
                .target(name: "TuitWatch"),
            ]
        ),
        .target(
            name: "TuitWidgets",
            destinations: [.iPhone, .iPad],
            product: .appExtension,
            bundleId: "dev.andrewgarrett.tuit.widgets",
            deploymentTargets: .iOS("17.4"),
            infoPlist: .extendingDefault(with: [
                "CFBundleDisplayName": "Tuit",
                "CFBundleShortVersionString": "$(MARKETING_VERSION)",
                "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)",
                "TuitServer": .string("https://\(host)"),
                "TuitIssuer": .string(issuer),
                "TuitClientId": .string(clientId),
                "NSAppTransportSecurity": ["NSAllowsLocalNetworking": true],
                "NSExtension": [
                    "NSExtensionPointIdentifier": "com.apple.widgetkit-extension",
                ],
            ]),
            sources: [
                "TuitWidgets/Sources/**",
                "Shared/Sources/**",
                "Tuit/Sources/Models.swift",
                "Tuit/Sources/Formatting.swift",
                "Tuit/Sources/Keychain.swift",
                "Tuit/Sources/Credentials.swift",
                "Tuit/Sources/API.swift",
                "Tuit/Sources/OfflineStore.swift",
            ],
            resources: ["TuitWidgets/Resources/**"],
            entitlements: .dictionary([
                "com.apple.security.application-groups": .array([
                    .string(appGroup),
                ]),
                "keychain-access-groups": .array([
                    .string(sharedKeychainGroup),
                ]),
            ])
        ),
        .target(
            name: "TuitWatch",
            destinations: [.appleWatch],
            product: .app,
            bundleId: "dev.andrewgarrett.tuit.watchkitapp",
            deploymentTargets: .watchOS("10.0"),
            infoPlist: .extendingDefault(with: [
                "CFBundleDisplayName": "Tuit",
                "CFBundleShortVersionString": "$(MARKETING_VERSION)",
                "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)",
                "WKApplication": true,
                "WKCompanionAppBundleIdentifier": "dev.andrewgarrett.tuit",
                "ITSAppUsesNonExemptEncryption": false,
            ]),
            sources: [
                "TuitWatch/Sources/**",
                "Shared/Sources/AppGroup.swift",
                "Shared/Sources/WidgetSnapshot.swift",
                "Tuit/Sources/Models.swift",
                "Tuit/Sources/Formatting.swift",
            ],
            resources: ["TuitWatch/Resources/**"],
            entitlements: .dictionary([
                "com.apple.security.application-groups": .array([
                    .string(appGroup),
                ]),
            ]),
            dependencies: [
                .target(name: "TuitWatchWidgets"),
            ]
        ),
        .target(
            name: "TuitWatchWidgets",
            destinations: [.appleWatch],
            product: .appExtension,
            bundleId: "dev.andrewgarrett.tuit.watchkitapp.widgets",
            deploymentTargets: .watchOS("10.0"),
            infoPlist: .extendingDefault(with: [
                "CFBundleDisplayName": "Tuit",
                "CFBundleShortVersionString": "$(MARKETING_VERSION)",
                "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)",
                "NSExtension": [
                    "NSExtensionPointIdentifier": "com.apple.widgetkit-extension",
                ],
            ]),
            sources: [
                "TuitWatchWidgets/Sources/**",
                "Shared/Sources/**",
                "Tuit/Sources/Models.swift",
                "Tuit/Sources/Formatting.swift",
            ],
            resources: ["TuitWatchWidgets/Resources/**"],
            entitlements: .dictionary([
                "com.apple.security.application-groups": .array([
                    .string(appGroup),
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
        .target(
            name: "TuitUITests",
            destinations: [.iPhone, .iPad],
            product: .uiTests,
            bundleId: "dev.andrewgarrett.tuit.uitests",
            deploymentTargets: .iOS("17.4"),
            infoPlist: .extendingDefault(with: ["NSAppTransportSecurity": ["NSAllowsLocalNetworking": true]]),
            sources: ["TuitUITests/**"],
            dependencies: [.target(name: "Tuit")]
        ),
    ]
)
