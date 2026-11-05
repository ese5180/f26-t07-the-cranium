import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

@main
struct CraniumApp: App {
    #if canImport(UIKit)
    @UIApplicationDelegateAdaptor(CraniumAppDelegate.self) private var delegate
    #else
    // The app's sources are type-checked for macOS too (scripts/check.sh), where there is no shell.
    @StateObject private var model = AppModel()
    @StateObject private var customer = CustomerModel()
    #endif

    init() {
        #if canImport(UIKit)
        // From iOS 26 the system's own bars, which an opaque appearance would break: a list's large
        // title went missing under one. Before that, the console's ink for titles, on its paper.
        if #available(iOS 26, *) { return }
        let ink = UIColor(named: "PageInk") ?? .label
        let bar = UINavigationBarAppearance()
        bar.configureWithOpaqueBackground()
        bar.backgroundColor = UIColor(named: "PagePaper")
        bar.shadowColor = UIColor(named: "PageLine")
        bar.titleTextAttributes = [.foregroundColor: ink]
        bar.largeTitleTextAttributes = [.foregroundColor: ink]
        UINavigationBar.appearance().standardAppearance = bar
        UINavigationBar.appearance().scrollEdgeAppearance = bar
        UINavigationBar.appearance().compactAppearance = bar
        let tabs = UITabBarAppearance()
        tabs.configureWithOpaqueBackground()
        tabs.backgroundColor = UIColor(named: "PageSurface")
        tabs.shadowColor = UIColor(named: "PageLine")
        UITabBar.appearance().standardAppearance = tabs
        UITabBar.appearance().scrollEdgeAppearance = tabs
        UITabBar.appearance().unselectedItemTintColor = UIColor(named: "PageInk3")
        #endif
    }

    var body: some Scene {
        WindowGroup {
            #if canImport(UIKit)
            // From 0.8.0 the shell around the console's own pages, or the classic app (Shell/AppRoot.swift).
            AppRoot()
            #else
            RootView()
                .environmentObject(model)
                .environmentObject(customer)
            #endif
        }
    }
}
