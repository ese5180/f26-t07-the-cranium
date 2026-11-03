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
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.Tone
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The app: the sign-in page, or the console with its sections. */
@Composable
fun CraniumApp(vm: ConsoleViewModel) {
    val gate by vm.gate.collectAsStateWithLifecycle()
    val signIn = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        vm.onSignInResult(result.data)
    }
    // The fresh sign-in a change waits for: the console asks for it, the screen opens it.
    LaunchedEffect(Unit) { vm.signInPages.collect { signIn.launch(it) } }

    Surface(Modifier.fillMaxSize(), color = console.paper, contentColor = console.ink) {
        when (val current = gate) {
            Gate.Starting -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = console.accent)
            }
            is Gate.SignIn -> SignInPage(current, vm.exampleConfig, onSignIn = { vm.signInIntent()?.let(signIn::launch) }, onRetry = vm::retryStart)
            Gate.Ready -> ConsoleFrame(vm)
        }
    }
}

/** The mark of the console: a dome cut with the grooves of a record. */
@Composable
fun BrandMark(size: androidx.compose.ui.unit.Dp = 30.dp) {
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

@Composable
private fun SignInPage(gate: Gate.SignIn, example: Boolean, onSignIn: () -> Unit, onRetry: () -> Unit) {
    val colors = console
    Column(
        Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .verticalScroll(rememberScrollState())
            .padding(Gutter),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(11.dp)) {
            BrandMark()
            Column {
                Text("Cranium", style = ConsoleType.sectionTitle.copy(fontSize = 19.sp), color = colors.ink)
                Text("Firmware console", style = ConsoleType.eyebrow.copy(letterSpacing = 0.sp, fontWeight = FontWeight.Normal), color = colors.ink3)
            }
        }
        Spacer(Modifier.height(24.dp))
        InkPanel {
            Eyebrow("Sign in")
            Spacer(Modifier.height(10.dp))
            Text("The console, on this phone", style = ConsoleType.pageTitle, color = console.ink)
            Spacer(Modifier.height(10.dp))
            Text(
                "With your e-mail address, your password and the code from your authenticator app. Everything the website " +
                    "does is here: the boards, their events, firmware, deployments, the activity log, API tokens, updates " +
                    "over Bluetooth and the serial console over USB.",
                style = ConsoleType.lede, color = console.ink2,
            )
            Spacer(Modifier.height(10.dp))
            Text(
                "A change made from the phone, such as a deployment or a revocation, asks for the password and code again " +
                    "when the last sign-in is older than 15 minutes.",
                style = ConsoleType.note, color = console.ink3,
            )
            Spacer(Modifier.height(20.dp))
            if (gate.busy != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = console.accent)
                    Text(gate.busy, color = console.ink2)
                }
            } else {
                ConsoleButton("Sign in", onSignIn, Modifier.fillMaxWidth(), kind = ButtonKind.PRIMARY, glyph = Glyph.LOCK)
            }
        }
        if (example) {
            Notice(
                Tone.WARN, Glyph.ALERT,
                "This build has the example configuration, so sign-in will not work. Run apps/configure.sh and build again.",
            )
        }
        gate.notice?.let { notice ->
            Notice(Tone.BAD, Glyph.ALERT, notice, action = if (notice.startsWith("Signed in, but")) {
                { ConsoleButton("Try again", onRetry, small = true) }
            } else {
                null
            })
        }
    }
}

/** The console: a masthead, the page, the bottom bar, the dialogs and the messages. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ConsoleFrame(vm: ConsoleViewModel) {
    val nav by vm.nav.collectAsStateWithLifecycle()
    val store by vm.store.collectAsStateWithLifecycle()
    val dialog by vm.dialog.collectAsStateWithLifecycle()
    val toasts by vm.toasts.collectAsStateWithLifecycle()
    val colors = console
    val route = nav.route
    // Every second where seconds are counted (a board's heartbeat and uptime), else as the website redraws.
    val now = rememberNow(if (route is Route.Board) 1_000 else 15_000)

    BackHandler(enabled = nav.canGoBack) { vm.back() }
    Polling(vm, route)

    Scaffold(
        containerColor = colors.paper,
        contentColor = colors.ink,
        topBar = { Masthead(nav, onBack = { vm.back() }, onAccount = { vm.open(Route.Account) }) },
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
            var refreshing by remember { mutableStateOf(false) }
            val scope = rememberCoroutineScope()
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = {
                    scope.launch {
                        refreshing = true
                        vm.refresh(route, full = true)
                        refreshing = false
                    }
                },
                modifier = Modifier.fillMaxSize(),
            ) {
                // Keyed by the page, so that each page starts at its top.
                androidx.compose.runtime.key(route.key) {
                    Column(
                        Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState())
                            .padding(horizontal = Gutter)
                            .padding(bottom = 32.dp),
                    ) {
                        if (vm.exampleConfig) {
                            Notice(
                                Tone.WARN, Glyph.ALERT,
                                "This build has the example configuration, so the console cannot be reached. Run apps/configure.sh and build again.",
                                Modifier.padding(top = 12.dp),
                            )
                        }
                        Page(vm, route, store, now)
                    }
                }
            }
            Toasts(toasts, onDismiss = vm::dismissToast, modifier = Modifier.align(Alignment.BottomCenter))
        }
    }

    when (val open = dialog) {
        is DialogState.Deploy -> DeployDialog(vm, open, store, now)
        is DialogState.Cancel -> CancelDialog(vm, open, store)
        is DialogState.Revoke -> RevokeDialog(vm, open, store, now)
        is DialogState.CreateToken -> CreateTokenDialog(vm, open, now)
        is DialogState.RevokeToken -> RevokeTokenDialog(vm, open, now)
        null -> Unit
    }
}

/** The page of a route. */
@Composable
private fun Page(vm: ConsoleViewModel, route: Route, store: Store, now: Long) {
    when (route) {
        Route.Overview -> OverviewScreen(vm, store, now)
        Route.Boards -> BoardsScreen(vm, store, now)
        is Route.Board -> BoardScreen(vm, store, route.thing, now)
        Route.Firmware -> FirmwareScreen(vm, store, now)
        Route.Events -> EventsScreen(vm, store, now)
        Route.More -> MoreScreen(vm, store)
        Route.Deployments -> DeploymentsScreen(vm, store, now)
        is Route.DeploymentPage -> DeploymentScreen(vm, store, route.id, now)
        Route.Activity -> ActivityScreen(vm, store, now)
        Route.Tokens -> TokensScreen(vm, store, now)
        Route.History -> HistoryScreen(vm, store, now)
        Route.Serial -> SerialScreen(vm, store.me)
        Route.Account -> AccountScreen(vm, store, now)
        is Route.Bluetooth -> BluetoothScreen(vm, store)
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

/** The masthead: the way back, the mark, and who is signed in. */
@Composable
private fun Masthead(nav: Nav, onBack: () -> Unit, onAccount: () -> Unit) {
    val colors = console
    val deep = nav.stacks.getValue(nav.tab).size > 1
    Row(
        Modifier
            .fillMaxWidth()
            .background(colors.paper)
            .statusBarsPadding()
            .drawBehind { drawLine(colors.line, Offset(0f, size.height), Offset(size.width, size.height), 1.dp.toPx()) }
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (deep) {
            Box(
                Modifier
                    .size(48.dp)
                    .clip(RoundedCornerShape(5.dp))
                    .clickable(role = Role.Button, onClickLabel = "Back", onClick = onBack)
                    .semantics { contentDescription = "Back" },
                contentAlignment = Alignment.Center,
            ) { GlyphIcon(Glyph.ARROW_LEFT, tint = colors.ink2) }
        } else {
            Spacer(Modifier.size(8.dp))
        }
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            BrandMark(26.dp)
            Column {
                Text("Cranium", style = ConsoleType.body.copy(fontWeight = FontWeight.Bold, fontSize = 17.sp), color = colors.ink)
                Text("Firmware console", style = ConsoleType.eyebrow.copy(letterSpacing = 0.sp, fontWeight = FontWeight.Normal), color = colors.ink3)
            }
        }
        Box(
            Modifier
                .size(48.dp)
                .clip(RoundedCornerShape(5.dp))
                .clickable(role = Role.Button, onClickLabel = "Account", onClick = onAccount)
                .semantics { contentDescription = "Account" },
            contentAlignment = Alignment.Center,
        ) { GlyphIcon(Glyph.USER, tint = colors.ink2) }
    }
}

/** The messages at the foot of the screen (`.toasts`). */
@Composable
private fun Toasts(toasts: List<Toast>, onDismiss: (Long) -> Unit, modifier: Modifier = Modifier) {
    val colors = console
    Column(modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (toast in toasts.takeLast(3)) {
            InkToast(toast, onDismiss, colors.dark)
        }
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
