import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

@main
struct CraniumApp: App {
    @StateObject private var model = AppModel()

    init() {
        #if canImport(UIKit)
        // The console's ink for titles, on its paper.
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
            RootView()
                .environmentObject(model)
        }
    }
}
