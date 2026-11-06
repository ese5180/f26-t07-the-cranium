import CraniumKit
import SwiftUI

/// The main window: the team's console, or the customer side, each with its own session, Touch ID and
/// lock (docs/mac-app.md), decided as on the iPhone (RootView.swift there): a customer who is signed in
/// comes first, else an admin who is, else the sign-in.
struct RootView: View {
    @EnvironmentObject private var session: MacSession
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var customer: CustomerModel
    /// The admin's stage before its last change, to tell a sign-out from "Sign in with password".
    @State private var adminStage: AppModel.Stage = .loading

    var body: some View {
        VStack(spacing: 0) {
            if app.configSource == .example {
                ExampleBanner()
            }
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .overlay(alignment: .bottom) {
            Toast(text: customer.adminMode ? app.toast : (customer.toast ?? app.toast))
        }
        .animation(.easeOut(duration: 0.2), value: app.toast)
        .animation(.easeOut(duration: 0.2), value: customer.toast)
        .task { await session.start() }
        .onChange(of: app.stage) { stage in
            if stage == .signedOut {
                RecentSearches().clear()
                customer.adminEnded(from: adminStage, message: app.signInMessage)
            }
            adminStage = stage
        }
        .sheet(isPresented: $app.offeringBiometrics) {
            if let biometry = app.biometry {
                BiometricOffer(biometry: biometry, text: BiometricWords.offerText(biometry)) { yes in
                    Task { await app.answerBiometricOffer(yes) }
                }
            }
        }
        .sheet(isPresented: $customer.offeringBiometrics) {
            if let biometry = customer.biometry {
                BiometricOffer(biometry: biometry, text: CustomerWords.biometricOffer(biometry)) { yes in
                    Task { await customer.answerBiometricOffer(yes) }
                }
            }
        }
    }

    @ViewBuilder private var content: some View {
        if case .broken(let text) = app.stage {
            PageState(kind: .failed, text: "This build cannot be used. \(text)")
        } else if customer.adminMode {
            switch app.stage {
            case .loading, .broken:
                ProgressView()
            case .signedOut:
                // Admin mode closes on a sign-out (onChange above): nothing in between.
                ProgressView()
            case .locked:
                LockView(model: app)
            case .signedIn:
                TeamView()
                    .lockCover(app)
            }
        } else {
            switch customer.stage {
            case .loading:
                ProgressView()
            case .locked:
                LockView(model: customer)
            case .signedIn:
                CustomerView()
                    .lockCover(customer)
            case .signedOut, .notSetUp:
                if app.holdsSession {
                    // Signed in as an admin, who left admin mode: the console again.
                    Color.clear.onAppear { customer.openAdminMode() }
                } else {
                    GateView()
                }
            }
        }
    }
}

/// A build made without apps/config/cranium.json: made-up values, and sign-in cannot work.
struct ExampleBanner: View {
    var body: some View {
        Label("This build has the example configuration, and sign-in cannot work. Run apps/configure.sh, then build again.",
              systemImage: "exclamationmark.triangle")
            .font(.callout)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(.orange.opacity(0.18))
    }
}

/// After a full sign-in: "Use Touch ID to open Cranium?", once per person, as on the phones.
struct BiometricOffer: View {
    let biometry: Biometry
    let text: String
    let answer: (Bool) -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: biometry.symbol)
                .font(.system(size: 44))
                .foregroundStyle(Color.accentColor)
            Text(BiometricWords.offerTitle(biometry)).font(.title2.weight(.semibold))
            Text(text)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 360)
            HStack {
                Button(BiometricWords.notNow) { answer(false) }
                    .keyboardShortcut(.cancelAction)
                Button(BiometricWords.offerYes(biometry)) { answer(true) }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(28)
        .frame(width: 440)
    }
}
