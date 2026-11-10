package com.craniumiot.cranium.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.Tone
import kotlinx.coroutines.delay

/** The app: the sign-in screen, the lock screen, or the console with its sections. */
@Composable
fun CraniumApp(vm: ConsoleViewModel) {
    val gate by vm.gate.collectAsStateWithLifecycle()
    val form by vm.signIn.collectAsStateWithLifecycle()
    val awsPage = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        vm.onSignInResult(result.data)
    }
    // The AWS sign-in page, when the app's own screen sends the person there.
    LaunchedEffect(Unit) { vm.signInPages.collect { awsPage.launch(it) } }

    Surface(Modifier.fillMaxSize(), color = console.paper, contentColor = console.ink) {
        when (val current = gate) {
            Gate.Starting -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = console.accent)
            }
            is Gate.SignIn -> SignInGate(vm, current, form)
            is Gate.Locked -> LockScreen(vm, current)
            Gate.Ready -> ConsoleFrame(vm)
        }
    }
}

/** The mark of the console: a dome cut with the grooves of a record. */
@Composable
fun BrandMark(size: Dp = 30.dp) {
    val colors = console
    val dome = remember { PathParser().parsePathString("M2 18a14 14 0 0 1 28 0v9a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z").toPath() }
    val grooves = remember { PathParser().parsePathString("M7 30V18a9 9 0 0 1 18 0v12M12 30V18a4 4 0 0 1 8 0v12").toPath() }
    Canvas(Modifier.size(size).clearAndSetSemantics {}) {
        val scale = this.size.width / 32f
        drawContext.transform.scale(scale, scale, Offset.Zero)
        drawPath(dome, colors.accent)
        drawPath(grooves, colors.paper, style = Stroke(width = 1.8f))
    }
}

/** The console: the page of the route, the bottom bar, the dialogs and the messages. */
@Composable
private fun ConsoleFrame(vm: ConsoleViewModel) {
    val nav by vm.nav.collectAsStateWithLifecycle()
    val store by vm.store.collectAsStateWithLifecycle()
    val dialog by vm.dialog.collectAsStateWithLifecycle()
    val toasts by vm.toasts.collectAsStateWithLifecycle()
    val fresh by vm.fresh.collectAsStateWithLifecycle()
    val offer by vm.offer.collectAsStateWithLifecycle()
    val colors = console
    val route = nav.route
    // Every second where seconds are counted (a board's heartbeat and uptime), else as the website redraws.
    val now = rememberNow(if (route is Route.BoardPage || route is Route.Board) 1_000 else 15_000)
    val deep = nav.stacks.getValue(nav.tab).size > 1

    BackHandler(enabled = nav.canGoBack) { vm.back() }
    Polling(vm, route)

    Scaffold(
        containerColor = colors.paper,
        contentColor = colors.ink,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        bottomBar = {
            NavigationBar(containerColor = colors.surface, contentColor = colors.ink, tonalElevation = 0.dp) {
                for (tab in Tab.entries) {
                    val selected = nav.tab == tab
                    NavigationBarItem(
                        selected = selected,
                        onClick = { vm.selectTab(tab) },
                        icon = { GlyphIcon(tab.glyph, size = 22.dp) },
                        label = { Text(tab.label, fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal) },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = colors.accent,
                            selectedTextColor = colors.ink,
                            indicatorColor = colors.accentWash,
                            unselectedIconColor = colors.ink2,
                            unselectedTextColor = colors.ink2,
                        ),
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            val chrome = remember(deep, nav.tab) {
                Chrome(
                    canGoBack = deep,
                    onBack = { vm.back() },
                    onSearch = { vm.open(Route.SearchPage) },
                    onHelp = { topic -> vm.open(Route.HelpPage(topic)) },
                )
            }
            CompositionLocalProvider(LocalChrome provides chrome) {
                // Keyed by the page, so that each page starts at its top. Above it, a newer app (update/).
                com.craniumiot.cranium.update.AppUpdateFrame(vm.appUpdate) { key(route.key) { Page(vm, route, store, now) } }
            }
            Toasts(toasts, onDismiss = vm::dismissToast, modifier = Modifier.align(Alignment.BottomCenter))
        }
    }

    when (val open = dialog) {
        is DialogState.Deploy -> DeployDialog(vm, open, store, now)
        is DialogState.Cancel -> CancelDialog(vm, open, store)
        is DialogState.Revoke -> RevokeDialog(vm, open, store, now)
        is DialogState.Notes -> NotesDialog(vm, open)
        is DialogState.CreateToken -> CreateTokenDialog(vm, open, now)
        is DialogState.RevokeToken -> RevokeTokenDialog(vm, open, now)
        null -> Unit
    }
    fresh?.let { FreshSignInDialog(vm, it) }
    if (offer && dialog == null && fresh == null) FingerprintOffer(vm)
}

/** The page of a route. */
@Composable
private fun Page(vm: ConsoleViewModel, route: Route, store: Store, now: Long) {
    when (route) {
        Route.Overview -> OverviewScreen(vm, store, now)
        Route.Boards -> BoardsScreen(vm, store, now)
        is Route.Board -> BoardScreen(vm, store, route.thing, now)
        is Route.BoardPage -> BoardPartScreen(vm, store, route.thing, route.part, now)
        Route.Firmware -> FirmwareScreen(vm, store, now)
        is Route.Release -> ReleaseScreen(vm, store, route.version, now)
        Route.Upload -> UploadScreen(vm, store)
        Route.Events -> EventsScreen(vm, store, now)
        Route.More -> MoreScreen(vm, store)
        Route.Deployments -> DeploymentsScreen(vm, store, now)
        is Route.DeploymentPage -> DeploymentScreen(vm, store, route.id, now)
        is Route.ExecutionPage -> ExecutionScreen(vm, store, route.id, route.thing, now)
        Route.Activity -> ActivityScreen(vm, store, now)
        is Route.ActivityEntry -> ActivityEntryScreen(vm, store, route.id, now)
        Route.Tokens -> TokensScreen(vm, store, now)
        is Route.TokenPage -> TokenScreen(vm, store, route.id, now)
        Route.History -> HistoryScreen(vm, store, now)
        Route.Serial -> SerialScreen(vm, store.me)
        Route.BoardSetup -> BoardSetupScreen(vm)
        Route.Account -> AccountScreen(vm, store, now)
        is Route.Bluetooth -> BluetoothScreen(vm, store)
        Route.Offline -> OfflineScreen(vm)
        Route.SearchPage -> SearchScreen(vm, store)
        is Route.HelpPage -> HelpScreen(vm, route.topic)
    }
}

/**
 * Read a page when it opens and again on its schedule (the website's refreshPlan): nothing is
 * read while the app is in the background, and a page is read in full again when it comes back.
 */
@Composable
private fun Polling(vm: ConsoleViewModel, route: Route) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(route.key) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            vm.refresh(route, full = true)
            while (true) {
                delay(1_000)
                if (vm.due(route)) vm.refresh(route, full = false)
            }
        }
    }
}

/** The messages at the foot of the screen (`.toasts`). */
@Composable
private fun Toasts(toasts: List<Toast>, onDismiss: (Long) -> Unit, modifier: Modifier = Modifier) {
    val colors = console
    Column(modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (toast in toasts.takeLast(3)) InkToast(toast, onDismiss, colors.dark)
    }
}

@Composable
private fun InkToast(toast: Toast, onDismiss: (Long) -> Unit, dark: Boolean) {
    val ink = if (dark) ConsoleColors.InkOnDark else ConsoleColors.InkOnLight
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(6.dp))
            .background(ink.surface)
            .padding(start = 14.dp, top = 6.dp, bottom = 6.dp, end = 4.dp)
            .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        GlyphIcon(
            when (toast.tone) {
                Tone.BAD -> Glyph.X_CIRCLE
                Tone.WARN -> Glyph.ALERT
                else -> Glyph.CHECK_CIRCLE
            },
            tint = ink.toneInk(toast.tone),
        )
        Text(prose(toast.text), Modifier.weight(1f).padding(vertical = 6.dp), style = ConsoleType.small, color = ink.ink)
        Box(
            Modifier
                .size(44.dp)
                .clip(RoundedCornerShape(5.dp))
                .clickable(role = Role.Button, onClickLabel = "Dismiss") { onDismiss(toast.id) }
                .semantics { contentDescription = "Dismiss" },
            contentAlignment = Alignment.Center,
        ) { GlyphIcon(Glyph.X, tint = ink.ink2) }
    }
}
