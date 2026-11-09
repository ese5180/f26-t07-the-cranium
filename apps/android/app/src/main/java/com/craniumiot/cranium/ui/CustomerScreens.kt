package com.craniumiot.cranium.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.craniumiot.cranium.core.BiometricState
import com.craniumiot.cranium.core.CustomerAccount
import com.craniumiot.cranium.core.CustomerBoard
import com.craniumiot.cranium.core.CustomerBoardWords
import com.craniumiot.cranium.core.CustomerEvent
import com.craniumiot.cranium.core.CustomerText
import com.craniumiot.cranium.core.FingerprintWords
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.Me
import com.craniumiot.cranium.core.SignInWords
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.Words
import kotlinx.coroutines.delay

/*
 * The customer side (docs/mobile-apps.md, "Customers"): the customer site's pages
 * (cloud/web/src/customer/assets/customer-views.js) on a phone, in the console's colours and pieces,
 * with the site's words (core/CustomerText.kt). Admin mode is the console itself (CraniumApp).
 */

/** The app: the customer side or admin mode, whichever is in front, each with its own session. */
@Composable
fun CraniumRoot(customer: CustomerViewModel, staff: ConsoleViewModel) {
    val side by customer.side.collectAsStateWithLifecycle()
    val held by staff.held.collectAsStateWithLifecycle()
    LaunchedEffect(staff) { customer.attachTeam(staff.teamSignIn) }
    LaunchedEffect(held) { customer.noteStaff(held) }
    LaunchedEffect(Unit) { staff.signedOut.collect { customer.afterAdminSignOut() } }
    when (side) {
        Side.STARTING -> Surface(Modifier.fillMaxSize(), color = console.paper) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = console.accent) }
        }
        Side.CUSTOMER -> CustomerApp(customer, staff, adminHeld = held == true)
        Side.ADMIN -> {
            val exits = remember(customer) { AdminExits(leave = customer::leaveAdmin) }
            CompositionLocalProvider(LocalAdminExits provides exits) { CraniumApp(staff) }
        }
    }
}

@Composable
private fun CustomerApp(vm: CustomerViewModel, staff: ConsoleViewModel, adminHeld: Boolean) {
    val gate by vm.gate.collectAsStateWithLifecycle()
    val colors = com.craniumiot.cranium.ui.console
    Surface(Modifier.fillMaxSize(), color = colors.paper, contentColor = colors.ink) {
        when (val current = gate) {
            CustomerGate.Starting -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = colors.accent)
            }
            CustomerGate.SignIn -> CustomerSignInScreen(vm)
            CustomerGate.Forgot -> ForgotScreen(vm)
            is CustomerGate.Locked -> CustomerLockScreen(vm, current)
            CustomerGate.Frame -> CustomerFrame(vm, staff, adminHeld)
        }
    }
}

// The frame of the pages: the sections at the foot, as the site has them at 390 px.

@Composable
private fun CustomerFrame(vm: CustomerViewModel, staff: ConsoleViewModel, adminHeld: Boolean) {
    val nav by vm.nav.collectAsStateWithLifecycle()
    val store by vm.store.collectAsStateWithLifecycle()
    val signedIn by vm.signedIn.collectAsStateWithLifecycle()
    val toasts by vm.toasts.collectAsStateWithLifecycle()
    val offer by vm.offer.collectAsStateWithLifecycle()
    val staffStore by staff.store.collectAsStateWithLifecycle()
    val colors = console
    val now = rememberNow(15_000)
    val tabs = if (signedIn) CustomerTab.entries else listOf(CustomerTab.OVERVIEW, CustomerTab.MIXES, CustomerTab.HELP)
    val signOut = {
        // As the customer site's Sign out: the admin's session too, then the customer's.
        staff.signOutHere()
        vm.signOut()
    }

    BackHandler(enabled = nav.board != null || nav.tab != CustomerTab.OVERVIEW) { vm.back() }
    CustomerPolling(vm, nav, signedIn)

    Scaffold(
        containerColor = colors.paper,
        contentColor = colors.ink,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        bottomBar = {
            NavigationBar(containerColor = colors.surface, contentColor = colors.ink, tonalElevation = 0.dp) {
                for (tab in tabs) {
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
            val chrome = remember(nav.board, nav.tab) {
                Chrome(canGoBack = nav.board != null, onBack = { vm.back() }, onSearch = null, onHelp = { vm.selectTab(CustomerTab.HELP) })
            }
            CompositionLocalProvider(LocalChrome provides chrome) {
                key(nav.tab, nav.board) {
                    when {
                        !signedIn && nav.tab == CustomerTab.OVERVIEW -> AdminOverview(vm, staffStore.me, signOut)
                        nav.tab == CustomerTab.OVERVIEW -> CustomerOverview(vm, store, adminHeld, now)
                        nav.tab == CustomerTab.DEVICES && nav.board != null -> BoardPage(vm, store, nav.board!!, now)
                        nav.tab == CustomerTab.DEVICES -> DevicesPage(vm, store, now)
                        nav.tab == CustomerTab.MIXES -> MixesPage(vm, nav.mixTab)
                        nav.tab == CustomerTab.ACCOUNT -> CustomerAccountPage(vm, store, adminHeld, signOut)
                        else -> CustomerHelpPage()
                    }
                }
            }
            CustomerToasts(toasts, vm::dismissToast, Modifier.align(Alignment.BottomCenter))
        }
    }
    if (offer) CustomerFingerprintOffer(vm)
}

/** Read the section in front when it opens, and every 30 s while it shows (customer.js REFRESH_MS). */
@Composable
private fun CustomerPolling(vm: CustomerViewModel, nav: CustomerNav, signedIn: Boolean) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(nav.tab, nav.board, signedIn) {
        if (!signedIn) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            vm.refresh(full = true)
            val polled = nav.tab == CustomerTab.OVERVIEW || nav.tab == CustomerTab.DEVICES
            while (polled) {
                delay(CustomerViewModel.REFRESH_MS)
                vm.refresh(full = false)
            }
        }
    }
}

@Composable
private fun CustomerToasts(toasts: List<Toast>, onDismiss: (Long) -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (toast in toasts.takeLast(3)) {
            Notice(
                toast.tone, if (toast.tone == Tone.GOOD) Glyph.CHECK_CIRCLE else Glyph.ALERT, toast.text,
                Modifier.clickable(role = Role.Button, onClickLabel = "Dismiss") { onDismiss(toast.id) },
            )
        }
    }
}

/** A page's head (customer-views.js head): an eyebrow, the title, a line under it, and what stands beside. */
@Composable
private fun Head(eyebrow: String?, title: String, lede: String?, tools: (@Composable () -> Unit)? = null) {
    val colors = com.craniumiot.cranium.ui.console
    Column(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (eyebrow != null) Eyebrow(eyebrow)
        Text(title, Modifier.semantics { heading() }, style = ConsoleType.pageTitle.copy(fontSize = 27.sp, lineHeight = 31.sp), color = colors.ink)
        if (lede != null) Text(prose(lede), style = ConsoleType.lede, color = colors.ink2)
        if (tools != null) Wrap { tools() }
    }
}

private fun problemOf(resource: Resource<*>, what: String): String? =
    resource.error?.let { "${CustomerText.couldNotLoad(what)}${messageOf(it)}" }

@Composable
private fun AdminModeButton(vm: CustomerViewModel) {
    ConsoleButton(CustomerText.ADMIN_MODE, vm::openAdmin, kind = ButtonKind.PRIMARY, glyph = Glyph.KEY, small = true)
}

@Composable
private fun StateBadge(board: CustomerBoard, now: Long) {
    val words = CustomerBoardWords.statusWords(board, now)
    Badge(words.tone, words.glyph, words.label)
}

// Overview.

@Composable
private fun CustomerOverview(vm: CustomerViewModel, store: CustomerStore, adminHeld: Boolean, now: Long) {
    val boards = store.boards.value
    val name = store.me.value?.name.orEmpty()
    ConsoleScreen(title = CustomerText.OVERVIEW, onRefresh = { vm.refresh(full = true) }) {
        block("head") {
            Head(
                CustomerText.OVERVIEW_EYEBROW,
                if (name.isNotEmpty()) CustomerText.hello(name) else CustomerText.WELCOME,
                CustomerText.OVERVIEW_LEDE,
                tools = {
                    if (boards != null) {
                        val summary = CustomerBoardWords.summarize(boards)
                        Badge(
                            if (summary.online > 0) Tone.GOOD else Tone.IDLE,
                            if (summary.online > 0) Glyph.ONLINE else Glyph.OFFLINE,
                            CustomerBoardWords.onlineWords(summary),
                        )
                    }
                    if (adminHeld) AdminModeButton(vm)
                },
            )
        }
        problemOf(store.boards, CustomerText.THE_BOARDS)?.let { text ->
            block("problem") { Notice(Tone.BAD, Glyph.ALERT, text, action = { ConsoleButton(CustomerText.TRY_AGAIN, vm::refreshNow, small = true) }) }
        }
        if (boards == null) {
            if (store.boards.error == null) loading(CustomerText.THE_BOARDS)
            return@ConsoleScreen
        }
        block("tiles") { Tiles(boards, now) }
        block("boards") {
            Section(
                title = CustomerText.YOUR_BOARDS,
                more = if (boards.isNotEmpty()) CustomerText.ALL_DEVICES to { vm.selectTab(CustomerTab.DEVICES) } else null,
            ) {
                if (boards.isEmpty()) {
                    EmptyState(Glyph.CHIP, CustomerText.NO_BOARDS, CustomerText.NO_BOARDS_TEXT)
                } else {
                    for (board in boards) BoardRow(board, now) { vm.openBoard(board.id) }
                }
            }
        }
        block("lately") {
            Section(title = CustomerText.LATELY) {
                problemOf(store.activity, CustomerText.WHAT_YOUR_BOARDS_DID)?.let { Notice(Tone.BAD, Glyph.ALERT, it) }
                val activity = store.activity.value
                when {
                    activity == null -> if (store.activity.error == null) Loading(CustomerText.WHAT_YOUR_BOARDS_DID)
                    activity.isEmpty() -> Note(CustomerText.NOTHING_WEEK)
                    else -> ActivityList(activity.take(8), boards, now, compact = true)
                }
            }
        }
        block("teaser") { MixesTeaser { vm.selectTab(CustomerTab.MIXES) } }
    }
}

/** The four figures: online now (the ink panel), boards, firmware, last heard from. */
@Composable
private fun Tiles(boards: List<CustomerBoard>, now: Long) {
    val summary = CustomerBoardWords.summarize(boards)
    val versions = summary.versions
    val firmware = when (versions.size) {
        0 -> "—"
        1 -> CustomerBoardWords.shortVersion(versions[0])
        else -> CustomerText.versions(versions.size)
    }
    Column(Modifier.padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        InkPanel {
            Tile(
                CustomerText.ONLINE_NOW, Glyph.ONLINE,
                if (summary.total == 0) "0" else "${summary.online} of ${summary.total}",
                if (summary.busy > 0) CustomerText.updating(summary.busy) else CustomerText.EACH_REPORTS,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            TileBox(Modifier.weight(1f)) { Tile(CustomerText.BOARDS, Glyph.CHIP, summary.total.toString(), CustomerText.ON_ACCOUNT) }
            TileBox(Modifier.weight(1f)) {
                Tile(CustomerText.FIRMWARE, Glyph.PACKAGE, firmware, if (versions.size > 1) CustomerText.NOT_SAME else CustomerText.KEPT_UP)
            }
        }
        TileBox(Modifier.fillMaxWidth()) {
            Tile(
                CustomerText.LAST_HEARD, Glyph.CLOCK,
                summary.lastSeen?.let { Words.timeAgo(it, now) } ?: "—",
                summary.lastSeen?.let { Words.dateAndTime(it) } ?: CustomerText.NO_REPORT,
            )
        }
    }
}

@Composable
private fun TileBox(modifier: Modifier, content: @Composable () -> Unit) {
    val colors = com.craniumiot.cranium.ui.console
    Box(
        modifier
            .clip(RoundedCornerShape(6.dp))
            .background(colors.surface)
            .then(Modifier.padding(16.dp)),
    ) { content() }
}

@Composable
private fun Tile(label: String, glyph: Glyph, value: String, note: String) {
    val colors = com.craniumiot.cranium.ui.console
    Column(Modifier.semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            GlyphIcon(glyph, size = 15.dp, tint = colors.ink2)
            Text(label, style = ConsoleType.note.copy(fontWeight = FontWeight.Medium), color = colors.ink2)
        }
        Text(value, style = ConsoleType.figure.copy(fontSize = 30.sp, lineHeight = 34.sp), color = colors.ink, maxLines = 2)
        Text(note, style = ConsoleType.note, color = colors.ink3)
    }
}

@Composable
private fun BoardRow(board: CustomerBoard, now: Long, onClick: () -> Unit) {
    val meta = listOf(
        board.firmware?.let { CustomerText.firmwareOf(CustomerBoardWords.shortVersion(it.version)) } ?: CustomerText.FIRMWARE_NOT_REPORTED,
        board.lastSeen?.let { CustomerText.heardFrom(Words.timeAgo(it, now)) } ?: CustomerText.NOT_HEARD_YET,
    ).joinToString(" · ")
    ListRow(
        CustomerBoardWords.boardTitle(board),
        supporting = meta,
        overline = board.boardName?.takeIf { it != board.name },
        leading = { BrandMark(26.dp) },
        trailing = { StateBadge(board, now) },
        onClick = onClick,
        note = CustomerBoardWords.updateWords(board),
    )
}

/** What the boards did: an icon, the words, and which board and when. */
@Composable
private fun ActivityList(events: List<CustomerEvent>, boards: List<CustomerBoard>?, now: Long, compact: Boolean) {
    val names = boards.orEmpty().associate { it.id to CustomerBoardWords.boardTitle(it) }
    val colors = com.craniumiot.cranium.ui.console
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        for (event in events) {
            val words = CustomerBoardWords.eventWords(event)
            Row(Modifier.semantics(mergeDescendants = true) {}, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(Modifier.size(30.dp).clip(CircleShape).background(colors.well), contentAlignment = Alignment.Center) {
                    GlyphIcon(words.glyph, size = 16.dp, tint = colors.ink2)
                }
                Column(Modifier.weight(1f)) {
                    Text(prose(words.text), style = ConsoleType.small, color = colors.ink)
                    val whose = if (names.size > 1 || compact) "${names[event.board] ?: CustomerText.A_BOARD} · " else ""
                    Text("$whose${Words.timeAgo(event.at, now)}", style = ConsoleType.note, color = colors.ink3)
                }
            }
        }
    }
}

@Composable
private fun MixesTeaser(onOpen: () -> Unit) {
    val colors = com.craniumiot.cranium.ui.console
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(6.dp))
            .background(colors.surface)
            .padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            GlyphIcon(Glyph.DISC, size = 14.dp, tint = colors.ink3)
            Eyebrow(CustomerText.TEASER_EYEBROW)
        }
        Text(CustomerText.TEASER_TITLE, Modifier.semantics { heading() }, style = ConsoleType.sectionTitle, color = colors.ink)
        Text(CustomerText.TEASER_TEXT, style = ConsoleType.small, color = colors.ink2)
        MoreLink(CustomerText.WHAT_IS_COMING, onOpen)
    }
}

/** With only an admin signed in: who, and Open admin mode (customer-views.js adminOverview). */
@Composable
private fun AdminOverview(vm: CustomerViewModel, me: Me?, signOut: () -> Unit) {
    val colors = com.craniumiot.cranium.ui.console
    ConsoleScreen(title = CustomerText.OVERVIEW) {
        block("head") {
            val email = me?.email.orEmpty()
            Head(
                CustomerText.ADMIN, CustomerText.ADMIN_TITLE,
                if (me != null && email.isNotEmpty()) CustomerText.adminLede(email, me.canWrite) else CustomerText.ADMIN_LEDE,
            )
        }
        block("panel") {
            InkPanel {
                Eyebrow(CustomerText.ADMIN_MODE)
                Spacer(Modifier.height(6.dp))
                Text(CustomerText.ADMIN_PANEL_TITLE, Modifier.semantics { heading() }, style = ConsoleType.sectionTitle.copy(fontSize = 20.sp))
                Spacer(Modifier.height(8.dp))
                Text(CustomerText.ADMIN_PANEL_TEXT, style = ConsoleType.small, color = com.craniumiot.cranium.ui.console.ink2)
                Spacer(Modifier.height(14.dp))
                ConsoleButton(CustomerText.OPEN_ADMIN_MODE, vm::openAdmin, Modifier.fillMaxWidth(), kind = ButtonKind.PRIMARY, glyph = Glyph.KEY)
            }
        }
        block("customers") {
            Spacer(Modifier.height(16.dp))
            Section(title = CustomerText.WHAT_CUSTOMERS_SEE) {
                Text(CustomerText.WHAT_CUSTOMERS_SEE_TEXT, style = ConsoleType.small, color = colors.ink2)
            }
        }
        block("ways") {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                ConsoleButton(CustomerText.SIGN_OUT, signOut, Modifier.fillMaxWidth(), kind = ButtonKind.QUIET, glyph = Glyph.SIGN_OUT)
            }
        }
    }
}

// Devices, and one board.

@Composable
private fun DevicesPage(vm: CustomerViewModel, store: CustomerStore, now: Long) {
    val boards = store.boards.value
    ConsoleScreen(title = CustomerText.DEVICES, onRefresh = { vm.refresh(full = true) }) {
        block("head") { Head(CustomerText.STUDIO, CustomerText.YOUR_BOARDS, CustomerText.DEVICES_LEDE) }
        problemOf(store.boards, CustomerText.THE_BOARDS)?.let { text ->
            block("problem") { Notice(Tone.BAD, Glyph.ALERT, text, action = { ConsoleButton(CustomerText.TRY_AGAIN, vm::refreshNow, small = true) }) }
        }
        when {
            boards == null -> if (store.boards.error == null) loading(CustomerText.THE_BOARDS)
            boards.isEmpty() -> block("none") { EmptyState(Glyph.CHIP, CustomerText.NO_BOARDS, CustomerText.NO_BOARDS_TEXT) }
            else -> for (board in boards) item(key = board.id) { BoardRow(board, now) { vm.openBoard(board.id) } }
        }
    }
}

@Composable
private fun BoardPage(vm: CustomerViewModel, store: CustomerStore, id: String, now: Long) {
    val detail = store.details[id]
    val value = detail?.value
    val board = value?.board
    ConsoleScreen(title = board?.let { CustomerBoardWords.boardTitle(it) } ?: CustomerText.BOARD, onRefresh = { vm.refresh(full = true) }) {
        if (value == null) {
            val error = detail?.error
            when {
                error == null -> loading(CustomerText.THE_BOARD)
                (error as? com.craniumiot.cranium.core.ApiError)?.status == 404 ->
                    block("gone") { EmptyState(Glyph.CHIP, CustomerText.NO_BOARD_HERE, CustomerText.NO_BOARD_HERE_TEXT) }
                else -> block("problem") {
                    Notice(Tone.BAD, Glyph.ALERT, detail?.let { problemOf(it, CustomerText.THE_BOARD) }.orEmpty(), action = {
                        ConsoleButton(CustomerText.TRY_AGAIN, vm::refreshNow, small = true)
                    })
                }
            }
            return@ConsoleScreen
        }
        val shown = value.board
        val words = CustomerBoardWords.statusWords(shown, now)
        block("head") {
            Head(
                shown.boardName?.takeIf { it != shown.name }?.let(CustomerText::boardNamed) ?: CustomerText.BOARD,
                CustomerBoardWords.boardTitle(shown),
                words.text,
                tools = { Badge(words.tone, words.glyph, words.label) },
            )
        }
        detail?.let { problemOf(it, CustomerText.THE_BOARD) }?.let { text -> block("problem") { Notice(Tone.BAD, Glyph.ALERT, text) } }
        block("facts") { Section(title = CustomerText.HOW_IT_IS) { BoardFacts(shown, now) } }
        block("note") {
            Row(Modifier.padding(bottom = 24.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                GlyphIcon(Glyph.SHIELD, tint = com.craniumiot.cranium.ui.console.ink3)
                Note(CustomerText.UPDATES_NOTE)
            }
        }
        block("activity") {
            Section(title = CustomerText.WHAT_IT_DID) {
                if (value.activity.isEmpty()) Note(CustomerText.NOTHING_30_DAYS) else ActivityList(value.activity, listOf(shown), now, compact = false)
            }
        }
    }
}

@Composable
private fun BoardFacts(board: CustomerBoard, now: Long) {
    val colors = com.craniumiot.cranium.ui.console
    val quality = Words.signalQuality(board.rssi)
    Facts(
        listOf(
            Fact(CustomerText.STATE) { StateBadge(board, now) },
            Fact(CustomerText.FIRMWARE) {
                val firmware = board.firmware
                if (firmware == null) {
                    Text(CustomerText.NOT_REPORTED_YET, style = ConsoleType.small)
                } else {
                    Wrap {
                        Mono(CustomerBoardWords.shortVersion(firmware.version), style = ConsoleType.mono.copy(fontWeight = FontWeight.SemiBold))
                        if (!firmware.confirmed) Tag(CustomerText.ON_TRIAL, tone = Tone.WARN)
                    }
                }
            },
            Fact(CustomerText.LAST_HEARD) {
                val seen = board.lastSeen
                if (seen == null) {
                    Text(CustomerText.NOT_YET, style = ConsoleType.small)
                } else {
                    Text(Words.timeAgo(seen, now), style = ConsoleType.small)
                    Quiet(Words.dateAndTime(seen), style = ConsoleType.note)
                }
            },
            Fact(CustomerText.UPDATE) { Text(prose(CustomerBoardWords.updateWords(board) ?: "—"), style = ConsoleType.small) },
            Fact(CustomerText.WIFI_SIGNAL) {
                if (quality == null) {
                    Text(CustomerText.NOT_REPORTED, style = ConsoleType.small)
                } else {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        SignalBars(quality.bars, old = !board.online)
                        Text(CustomerBoardWords.signalWords(board.rssi), style = ConsoleType.small)
                    }
                }
            },
            Fact(CustomerText.RUNNING_FOR) {
                val uptime = board.uptime
                Text(if (board.online && uptime != null) Words.duration(uptime) else "—", style = ConsoleType.small)
            },
            Fact(CustomerText.LOCATION) { Text(CustomerText.LOCATION_NOT_REPORTED, style = ConsoleType.small, color = colors.ink3) },
            Fact(CustomerText.YOURS_SINCE) { Text(board.since?.let { Words.dateAndTime(it) } ?: "—", style = ConsoleType.small) },
        ),
        labelWidth = 110.dp,
    )
}

// Mixes: what the boards cannot report yet, in so many words.

@Composable
private fun MixesPage(vm: CustomerViewModel, tab: String) {
    val colors = com.craniumiot.cranium.ui.console
    val words = CustomerText.MIX_TABS.firstOrNull { it.id == tab } ?: CustomerText.MIX_TABS.first()
    ConsoleScreen(title = CustomerText.MIXES) {
        block("head") { Head(CustomerText.MIXES_EYEBROW, CustomerText.MIXES_TITLE, CustomerText.MIXES_LEDE) }
        block("tabs") {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (each in CustomerText.MIX_TABS) {
                    FilterChip(
                        selected = each.id == words.id,
                        onClick = { vm.chooseMixTab(each.id) },
                        label = { Text(each.label) },
                        colors = FilterChipDefaults.filterChipColors(selectedContainerColor = colors.accentWash, selectedLabelColor = colors.ink),
                    )
                }
            }
        }
        block("placeholder") {
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(6.dp))
                    .background(colors.surface)
                    .padding(18.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Tag(CustomerText.NOT_BUILT, tone = Tone.WARN)
                Text(words.title, Modifier.semantics { heading() }, style = ConsoleType.sectionTitle.copy(fontSize = 20.sp), color = colors.ink)
                Text(words.text, style = ConsoleType.small, color = colors.ink2)
                Lanes()
                Text(CustomerText.WHY_EMPTY, style = ConsoleType.note, color = colors.ink2)
            }
        }
        block("note") {
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                GlyphIcon(Glyph.SHIELD, tint = colors.ink3)
                Note(CustomerText.MIXES_NOTE)
            }
        }
    }
}

/** Two decks as lanes, with nothing on them: what a session will look like, not a session. */
@Composable
private fun Lanes() {
    val colors = com.craniumiot.cranium.ui.console
    Canvas(Modifier.fillMaxWidth().height(64.dp).clearAndSetSemantics {}) {
        val unit = size.width / 320f
        val corner = CornerRadius(4 * unit, 4 * unit)
        for (y in listOf(6f, 38f)) drawRoundRect(colors.well, Offset(0f, y * unit), Size(size.width, 20 * unit), corner)
        for ((x, y, w) in listOf(Triple(8f, 6f, 70f), Triple(104f, 6f, 64f), Triple(200f, 6f, 76f), Triple(56f, 38f, 62f), Triple(150f, 38f, 70f), Triple(246f, 38f, 66f))) {
            drawRoundRect(colors.line, Offset(x * unit, y * unit), Size(w * unit, 20 * unit), corner)
        }
    }
}

// Account.

@Composable
private fun CustomerAccountPage(vm: CustomerViewModel, store: CustomerStore, adminHeld: Boolean, signOut: () -> Unit) {
    val colors = com.craniumiot.cranium.ui.console
    val profile = store.profile
    val fingerprint by vm.fingerprint.collectAsStateWithLifecycle()
    val newApp = com.craniumiot.cranium.shell.LocalNewApp.current
    ConsoleScreen(title = CustomerText.ACCOUNT, onRefresh = { vm.refresh(full = true) }) {
        block("head") { Head(CustomerText.STUDIO, CustomerText.YOUR_ACCOUNT, CustomerText.ACCOUNT_LEDE) }
        problemOf(profile, CustomerText.THE_ACCOUNT)?.let { text ->
            block("problem") { Notice(Tone.BAD, Glyph.ALERT, text, action = { ConsoleButton(CustomerText.TRY_AGAIN, vm::refreshNow, small = true) }) }
        }
        block("who") {
            Section(title = CustomerText.SIGNED_IN_AS) {
                val email = profile.value?.email?.ifEmpty { null } ?: store.me.value?.email?.ifEmpty { null } ?: "—"
                val name = profile.value?.name?.ifEmpty { null } ?: store.me.value?.name?.ifEmpty { null }
                Facts(
                    listOf(
                        Fact(CustomerText.EMAIL) { Text(email, style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold)) },
                        Fact(CustomerText.NAME) { Text(name ?: CustomerText.NOT_GIVEN, style = ConsoleType.small, color = if (name == null) colors.ink3 else colors.ink) },
                        Fact(CustomerText.SESSION) {
                            Text(if (fingerprint.on) CustomerText.SESSION_FINGERPRINT else CustomerText.SESSION_HOUR, style = ConsoleType.small)
                        },
                    ),
                )
                Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    GlyphIcon(Glyph.USER, tint = colors.ink3)
                    Note(CustomerText.EMAIL_NOTE)
                }
            }
        }
        block("password") { Section(title = CustomerText.PASSWORD) { PasswordCard(vm) } }
        block("two-step") {
            Section(title = CustomerText.TWO_STEP) {
                if (profile.value == null && profile.error == null) Loading(CustomerText.THE_ACCOUNT) else AuthenticatorCard(vm, profile.value?.authenticator == true, profile.value?.email)
            }
        }
        block("fingerprint") { CustomerFingerprintRow(vm, fingerprint) }
        if (adminHeld) {
            block("admin") { Section(title = CustomerText.ADMIN_MODE) { AdminModeButton(vm) } }
        }
        block("out") {
            Section(title = CustomerText.SIGN_OUT) {
                Note(CustomerText.SIGN_OUT_TEXT)
                Spacer(Modifier.height(10.dp))
                ConsoleButton(CustomerText.SIGN_OUT, signOut, glyph = Glyph.SIGN_OUT)
            }
        }
        // The classic app, from 0.8.0: back to the new one (shell/, docs/mobile-apps.md "The app shell").
        newApp?.let { open ->
            block("new-app") {
                Section(title = "The new app") {
                    Note("These are the classic app's screens, kept for this version only.")
                    Spacer(Modifier.height(10.dp))
                    ConsoleButton("Use the new app", open)
                }
            }
        }
    }
}

@Composable
private fun fieldColors() = com.craniumiot.cranium.ui.console.let { colors ->
    OutlinedTextFieldDefaults.colors(
        focusedBorderColor = colors.accent, unfocusedBorderColor = colors.lineField, focusedLabelColor = colors.accent,
        unfocusedLabelColor = colors.ink2, cursorColor = colors.accent, focusedContainerColor = colors.surface,
        unfocusedContainerColor = colors.surface, errorBorderColor = colors.bad, errorLabelColor = colors.bad,
    )
}

/** A password field: the password stays in it, never in saved state, and is cleared once it has been sent. */
@Composable
private fun PasswordField(value: String, onChange: (String) -> Unit, label: String, hint: String? = null, wrong: Boolean = false, newPassword: Boolean = false, readOnly: Boolean = false) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        modifier = Modifier.fillMaxWidth().semantics { contentType = if (newPassword) ContentType.NewPassword else ContentType.Password },
        label = { Text(label) },
        supportingText = hint?.let { { Text(it, color = com.craniumiot.cranium.ui.console.ink2) } },
        singleLine = true,
        readOnly = readOnly,
        isError = wrong,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false, imeAction = ImeAction.Next),
        shape = RoundedCornerShape(5.dp),
        colors = fieldColors(),
    )
}

/** One line of what went wrong, in the site's words, said again for each new answer. */
@Composable
private fun ProblemWords(problem: String?, tries: Int) {
    val text = problem?.let { SignInWords.WORDS[it] ?: CustomerAccount.WORDS[it] ?: SignInWords.WORDS.getValue("failed") } ?: return
    key(tries) {
        Row(Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Assertive }, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            GlyphIcon(Glyph.ALERT, Modifier.padding(top = 2.dp), tint = com.craniumiot.cranium.ui.console.bad)
            Text(text, style = ConsoleType.small, color = com.craniumiot.cranium.ui.console.ink)
        }
    }
}

/** An account problem: ACCOUNT_WORDS first, as the account page has them. */
@Composable
private fun AccountProblem(problem: String?, tries: Int) {
    val text = problem?.let { CustomerAccount.WORDS[it] ?: SignInWords.WORDS[it] ?: CustomerAccount.words(it) } ?: return
    key(tries) {
        Row(Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Assertive }, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            GlyphIcon(Glyph.ALERT, Modifier.padding(top = 2.dp), tint = com.craniumiot.cranium.ui.console.bad)
            Text(text, style = ConsoleType.small, color = com.craniumiot.cranium.ui.console.ink)
        }
    }
}

@Composable
private fun DoneLine(text: String) {
    Row(Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        GlyphIcon(Glyph.CHECK, tint = com.craniumiot.cranium.ui.console.good)
        Text(text, style = ConsoleType.small, color = com.craniumiot.cranium.ui.console.ink)
    }
}

@Composable
private fun PasswordCard(vm: CustomerViewModel) {
    val form by vm.password.collectAsStateWithLifecycle()
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var again by remember { mutableStateOf("") }
    LaunchedEffect(form.done) {
        if (form.done) {
            current = ""
            next = ""
            again = ""
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        PasswordField(current, { current = it }, CustomerText.CURRENT_PASSWORD, wrong = form.problem == "wrong-password", readOnly = form.busy)
        PasswordField(next, { next = it }, CustomerText.NEW_PASSWORD, hint = CustomerText.NEW_PASSWORD_HINT, newPassword = true, readOnly = form.busy)
        PasswordField(again, { again = it }, CustomerText.NEW_PASSWORD_AGAIN, newPassword = true, readOnly = form.busy)
        AccountProblem(form.problem, form.tries)
        if (form.done) DoneLine(CustomerText.PASSWORD_CHANGED)
        ConsoleButton(
            if (form.busy) CustomerText.SAVING else CustomerText.CHANGE_PASSWORD, { vm.changePassword(current, next, again) },
            kind = ButtonKind.PRIMARY, busy = form.busy,
        )
    }
}

@Composable
private fun AuthenticatorCard(vm: CustomerViewModel, on: Boolean, email: String?) {
    val form by vm.authenticator.collectAsStateWithLifecycle()
    val colors = com.craniumiot.cranium.ui.console
    val context = LocalContext.current
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (on) Badge(Tone.GOOD, Glyph.SHIELD, CustomerText.ON) else Badge(Tone.IDLE, Glyph.MINUS_CIRCLE, CustomerText.OFF)
        when {
            form.step == AuthenticatorStep.SECRET -> {
                val grouped = CustomerAccount.groupSecret(form.secret)
                val uri = CustomerAccount.otpauthUri(form.secret, email)
                NumberedStep(1, CustomerText.STEP_APP)
                NumberedStep(2, CustomerText.STEP_KEY)
                Text(
                    grouped,
                    Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .background(colors.well)
                        .padding(horizontal = 10.dp, vertical = 6.dp)
                        .semantics { contentDescription = "Setup key ${grouped.toList().joinToString(" ")}" },
                    style = ConsoleType.mono.copy(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                    color = colors.ink,
                )
                Wrap {
                    ConsoleButton(CustomerText.COPY_KEY, {
                        copyToClipboard(context, form.secret, "setup key", sensitive = true)
                        vm.notify(CustomerText.KEY_COPIED)
                    }, glyph = Glyph.COPY, small = true)
                    if (uri != null) {
                        ConsoleButton(CustomerText.OPEN_IN_APP, {
                            try {
                                context.startActivity(Intent(Intent.ACTION_VIEW, uri.toUri()))
                            } catch (e: ActivityNotFoundException) {
                                vm.notify(CustomerText.NO_AUTHENTICATOR, Tone.WARN)
                            }
                        }, glyph = Glyph.EXTERNAL, small = true)
                    }
                }
                NumberedStep(3, CustomerText.STEP_CODE)
                Text(CustomerText.CODE_FROM_APP, style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold), color = colors.ink)
                CodeBoxes(
                    code = form.code, onChange = vm::authenticatorCode, onDone = vm::confirmAuthenticator, busy = form.busy,
                    wrong = form.problem == "wrong-code" || form.problem == "short-code",
                    errorText = CustomerAccount.words(form.problem), tries = form.tries, focusNow = false,
                )
                Note(CustomerText.NEW_CODE_EVERY)
                ProblemWords(form.problem, form.tries)
                Wrap {
                    ConsoleButton(
                        if (form.busy) CustomerText.CHECKING else CustomerText.TURN_ON_TWO_STEP, vm::confirmAuthenticator,
                        kind = ButtonKind.PRIMARY, busy = form.busy,
                    )
                    ConsoleButton(CustomerText.NOT_NOW, vm::cancelAuthenticator, kind = ButtonKind.QUIET, enabled = !form.busy)
                }
            }
            on && form.step == AuthenticatorStep.CONFIRM_OFF -> {
                Text(CustomerText.OFF_WARNING, style = ConsoleType.small, color = colors.ink2)
                AccountProblem(form.problem, form.tries)
                Wrap {
                    ConsoleButton(if (form.busy) CustomerText.TURNING_OFF else CustomerText.TURN_IT_OFF, vm::stopAuthenticator, kind = ButtonKind.DANGER, busy = form.busy)
                    ConsoleButton(CustomerText.KEEP_IT_ON, vm::cancelAuthenticator, kind = ButtonKind.QUIET, enabled = !form.busy)
                }
            }
            else -> {
                Text(if (on) CustomerText.TWO_STEP_ON_TEXT else CustomerText.TWO_STEP_OFF_TEXT, style = ConsoleType.small, color = colors.ink2)
                AccountProblem(form.problem, form.tries)
                form.done?.let { DoneLine(it) }
                if (on) {
                    ConsoleButton(CustomerText.TURN_OFF, vm::askToStopAuthenticator)
                } else {
                    ConsoleButton(if (form.busy) CustomerText.STARTING else CustomerText.TURN_ON, vm::startAuthenticator, kind = ButtonKind.PRIMARY, busy = form.busy)
                }
            }
        }
    }
}

@Composable
private fun NumberedStep(number: Int, text: String) {
    val colors = com.craniumiot.cranium.ui.console
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("$number.", style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold), color = colors.ink2)
        Text(text, style = ConsoleType.small, color = colors.ink)
    }
}

@Composable
private fun CustomerFingerprintRow(vm: CustomerViewModel, fingerprint: FingerprintUi) {
    val ready = fingerprint.state == BiometricState.READY
    val enabled = !fingerprint.busy && (fingerprint.on || ready)
    ListRow(
        FingerprintWords.SETTING,
        modifier = Modifier.toggleable(value = fingerprint.on, enabled = enabled, role = Role.Switch, onValueChange = vm::setFingerprint),
        supporting = when {
            fingerprint.on -> "Asked when the app opens, and after 5 minutes away"
            !ready -> FingerprintWords.state(fingerprint.state)
            else -> CustomerText.FINGERPRINT_SETTING_OFF
        },
        leading = { GlyphIcon(Glyph.FINGERPRINT, tint = com.craniumiot.cranium.ui.console.ink2) },
        trailing = {
            Switch(
                checked = fingerprint.on,
                onCheckedChange = null,
                enabled = enabled,
                modifier = Modifier.clearAndSetSemantics {},
                colors = SwitchDefaults.colors(checkedTrackColor = com.craniumiot.cranium.ui.console.accent, checkedThumbColor = com.craniumiot.cranium.ui.console.onAccent),
            )
        },
        chevron = false,
    )
}

@Composable
private fun CustomerFingerprintOffer(vm: CustomerViewModel) {
    ConsoleDialog(
        title = androidx.compose.ui.text.AnnotatedString(FingerprintWords.OFFER_TITLE),
        onClose = { vm.answerOffer(false) },
        busy = false,
        foot = {
            ConsoleButton(CustomerText.NOT_NOW, { vm.answerOffer(false) }, kind = ButtonKind.QUIET)
            ConsoleButton("Yes", { vm.answerOffer(true) }, kind = ButtonKind.PRIMARY, glyph = Glyph.FINGERPRINT)
        },
    ) {
        Text(CustomerText.FINGERPRINT_OFFER, style = ConsoleType.body, color = com.craniumiot.cranium.ui.console.ink2)
    }
}

// Help.

@Composable
private fun CustomerHelpPage() {
    val colors = com.craniumiot.cranium.ui.console
    var open by rememberSaveable { mutableStateOf<String?>(null) }
    ConsoleScreen(title = CustomerText.HELP) {
        block("head") { Head(CustomerText.HELP_EYEBROW, CustomerText.HELP_TITLE, CustomerText.HELP_LEDE) }
        for (section in CustomerText.HELP_SECTIONS) {
            header(section.title, key = "help-${section.title}")
            for (question in section.questions) {
                item(key = question.question) {
                    val shown = open == question.question
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clickable(role = Role.Button, onClickLabel = if (shown) "Hide the answer" else "Show the answer") {
                                open = if (shown) null else question.question
                            }
                            .padding(horizontal = Gutter, vertical = 12.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(question.question, Modifier.weight(1f), style = ConsoleType.body.copy(fontWeight = FontWeight.SemiBold), color = colors.ink)
                            GlyphIcon(if (shown) Glyph.MINUS else Glyph.PLUS, size = 16.dp, tint = colors.ink3)
                        }
                        if (shown) Text(question.answer, style = ConsoleType.small, color = colors.ink2)
                    }
                    HorizontalDivider(Modifier.padding(horizontal = Gutter), color = colors.line)
                }
            }
        }
        block("stuck") {
            Spacer(Modifier.height(16.dp))
            Section(title = CustomerText.STILL_STUCK) { Text(CustomerText.NO_SUPPORT, style = ConsoleType.small, color = colors.ink2) }
        }
    }
}

// Signing in, and a forgotten password (customer-views.js signInView and forgotView).

@Composable
private fun GateColumn(content: @Composable () -> Unit) {
    val colors = com.craniumiot.cranium.ui.console
    Column(
        Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(Gutter),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(11.dp)) {
            BrandMark()
            Column {
                Text("Cranium", style = ConsoleType.sectionTitle.copy(fontSize = 19.sp), color = colors.ink)
                Text(CustomerText.STUDIO, style = ConsoleType.note, color = colors.ink3)
            }
        }
        Spacer(Modifier.height(12.dp))
        content()
        HorizontalDivider(color = colors.line)
        Text(CustomerText.GATE_FOOT, style = ConsoleType.note, color = colors.ink3)
    }
}

@Composable
private fun Title(text: String) {
    Text(text, Modifier.semantics { heading() }, style = ConsoleType.pageTitle, color = com.craniumiot.cranium.ui.console.ink)
}

@Composable
private fun Lead(text: String) {
    Text(prose(text), style = ConsoleType.body, color = com.craniumiot.cranium.ui.console.ink2)
}

@Composable
private fun EmailField(value: String, onChange: (String) -> Unit, wrong: Boolean, readOnly: Boolean, onNext: () -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        modifier = Modifier.fillMaxWidth().semantics { contentType = ContentType.Username },
        label = { Text(CustomerText.EMAIL_ADDRESS) },
        singleLine = true,
        readOnly = readOnly,
        isError = wrong,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false, imeAction = ImeAction.Next),
        keyboardActions = KeyboardActions(onNext = { onNext() }),
        shape = RoundedCornerShape(5.dp),
        colors = fieldColors(),
    )
}

@Composable
private fun CustomerSignInScreen(vm: CustomerViewModel) {
    val form by vm.signIn.collectAsStateWithLifecycle()
    val colors = com.craniumiot.cranium.ui.console
    GateColumn {
        if (vm.exampleConfig) {
            OneLine("This build has the example configuration, so sign-in will not work.", tone = Tone.WARN, glyph = Glyph.ALERT)
        }
        form.notice?.let { Notice(Tone.WARN, Glyph.ALERT, it) }
        if (vm.canSignIn) {
            when (form.phase) {
                CustomerPhase.PASSWORD -> {
                    Title(CustomerText.SIGN_IN)
                    Lead(form.lead ?: CustomerText.SIGN_IN_LEAD)
                    PasswordStep(vm, form)
                }
                CustomerPhase.CODE -> {
                    Title(CustomerText.ENTER_CODE)
                    Lead(CustomerText.signingInAs(form.email.trim()))
                    Text(CustomerText.CODE_FROM_APP, style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold), color = colors.ink)
                    CodeBoxes(
                        code = form.code, onChange = vm::codeChanged, onDone = vm::submitCode, busy = form.busy,
                        wrong = form.problem == "wrong-code" || form.problem == "short-code",
                        errorText = SignInWords.words(form.problem.orEmpty()), tries = form.tries,
                    )
                    Text(CustomerText.CODE_HINT, Modifier.widthIn(max = 420.dp), style = ConsoleType.note, color = colors.ink2)
                    ProblemWords(form.problem, form.tries)
                    ConsoleButton(
                        if (form.busy) CustomerText.CHECKING else CustomerText.SIGN_IN, vm::submitCode, Modifier.fillMaxWidth(),
                        kind = ButtonKind.PRIMARY, busy = form.busy,
                    )
                    ConsoleButton(CustomerText.START_AGAIN, vm::startOver, kind = ButtonKind.QUIET, small = true, enabled = !form.busy)
                }
                CustomerPhase.NEW_PASSWORD -> {
                    Title(CustomerText.CHOOSE_PASSWORD)
                    Lead(CustomerText.WELCOME_NEW)
                    NewPasswordStep(vm, form)
                }
                CustomerPhase.ELSEWHERE -> {
                    Title(CustomerText.ONE_MORE_STEP)
                    Lead(CustomerText.ELSEWHERE)
                    ConsoleButton(CustomerText.CHOOSE_NEW, vm::openForgot, Modifier.fillMaxWidth(), kind = ButtonKind.PRIMARY)
                }
            }
        }
    }
}

@Composable
private fun PasswordStep(vm: CustomerViewModel, form: CustomerSignInForm) {
    // The password lives in this field only, until it is handed to the proof.
    var password by remember { mutableStateOf("") }
    val wrong = form.problem == "wrong-password" || form.problem == "missing"
    val send = {
        val given = password
        password = ""
        vm.submitPassword(given)
    }
    EmailField(form.email, vm::signInEmail, wrong, form.busy) {}
    OutlinedTextField(
        value = password,
        onValueChange = { password = it },
        modifier = Modifier.fillMaxWidth().semantics { contentType = ContentType.Password },
        label = { Text(CustomerText.PASSWORD) },
        singleLine = true,
        readOnly = form.busy,
        isError = wrong,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false, imeAction = ImeAction.Go),
        keyboardActions = KeyboardActions(onGo = { if (!form.busy) send() }),
        shape = RoundedCornerShape(5.dp),
        colors = fieldColors(),
    )
    ProblemWords(form.problem, form.tries)
    ConsoleButton(
        if (form.busy) CustomerText.CHECKING else CustomerText.CONTINUE, { if (!form.busy) send() }, Modifier.fillMaxWidth(),
        kind = ButtonKind.PRIMARY, busy = form.busy,
    )
    ConsoleButton(CustomerText.FORGOT, vm::openForgot, kind = ButtonKind.QUIET, small = true, enabled = !form.busy)
}

@Composable
private fun NewPasswordStep(vm: CustomerViewModel, form: CustomerSignInForm) {
    var next by remember { mutableStateOf("") }
    var again by remember { mutableStateOf("") }
    PasswordField(next, { next = it }, CustomerText.NEW_PASSWORD, hint = CustomerText.AT_LEAST, newPassword = true, readOnly = form.busy)
    PasswordField(again, { again = it }, CustomerText.NEW_PASSWORD_AGAIN, newPassword = true, readOnly = form.busy)
    ProblemWords(form.problem, form.tries)
    ConsoleButton(
        if (form.busy) CustomerText.SAVING else CustomerText.SAVE_AND_SIGN_IN,
        {
            if (!form.busy) {
                val (first, second) = next to again
                next = ""
                again = ""
                vm.submitNewPassword(first, second)
            }
        },
        Modifier.fillMaxWidth(), kind = ButtonKind.PRIMARY, busy = form.busy,
    )
}

@Composable
private fun ForgotScreen(vm: CustomerViewModel) {
    val form by vm.forgot.collectAsStateWithLifecycle()
    val colors = com.craniumiot.cranium.ui.console
    BackHandler { vm.closeForgot() }
    GateColumn {
        Title(if (form.step == ForgotStep.DONE) CustomerText.DONE else CustomerText.A_NEW_PASSWORD)
        when (form.step) {
            ForgotStep.DONE -> {
                Lead(CustomerText.CHANGED_SIGN_IN)
                ConsoleButton(CustomerText.SIGN_IN, vm::closeForgot, Modifier.fillMaxWidth(), kind = ButtonKind.PRIMARY)
            }
            ForgotStep.CODE -> {
                var next by remember { mutableStateOf("") }
                var again by remember { mutableStateOf("") }
                LaunchedEffect(form.step) {
                    next = ""
                    again = ""
                }
                Lead(CustomerText.codeOnItsWay(form.email.trim()))
                Text(CustomerText.CODE_FROM_EMAIL, style = ConsoleType.small.copy(fontWeight = FontWeight.SemiBold), color = colors.ink)
                CodeBoxes(
                    code = form.code, onChange = vm::forgotCodeChanged, onDone = {}, busy = form.busy,
                    wrong = form.problem == "wrong-code" || form.problem == "short-code" || form.problem == "expired-code",
                    errorText = CustomerAccount.words(form.problem), tries = form.tries,
                )
                Note(CustomerText.CODE_FROM_EMAIL_HINT)
                PasswordField(next, { next = it }, CustomerText.NEW_PASSWORD, hint = CustomerText.AT_LEAST, newPassword = true, readOnly = form.busy)
                PasswordField(again, { again = it }, CustomerText.NEW_PASSWORD_AGAIN, newPassword = true, readOnly = form.busy)
                AccountProblem(form.problem, form.tries)
                ConsoleButton(
                    if (form.busy) CustomerText.SAVING else CustomerText.SET_PASSWORD, { vm.submitReset(next, again) }, Modifier.fillMaxWidth(),
                    kind = ButtonKind.PRIMARY, busy = form.busy,
                )
                ConsoleButton(CustomerText.SEND_ANOTHER, vm::forgotStartOver, kind = ButtonKind.QUIET, small = true, enabled = !form.busy)
            }
            ForgotStep.EMAIL -> {
                Lead(CustomerText.FORGOT_LEAD)
                EmailField(form.email, vm::forgotEmail, form.problem == "missing-email", form.busy) {}
                AccountProblem(form.problem, form.tries)
                ConsoleButton(
                    if (form.busy) CustomerText.SENDING else CustomerText.SEND_CODE, vm::submitForgotEmail, Modifier.fillMaxWidth(),
                    kind = ButtonKind.PRIMARY, busy = form.busy,
                )
            }
        }
        ConsoleButton(CustomerText.BACK_TO_SIGN_IN, vm::closeForgot, kind = ButtonKind.QUIET, glyph = Glyph.ARROW_LEFT, small = true, enabled = !form.busy)
    }
}

/** The lock screen of a customer's sign-in kept behind the fingerprint: nothing of the pages until it passes. */
@Composable
private fun CustomerLockScreen(vm: CustomerViewModel, gate: CustomerGate.Locked) {
    val colors = com.craniumiot.cranium.ui.console
    Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
        Column(
            Modifier.align(Alignment.Center).widthIn(max = 420.dp).fillMaxWidth().padding(horizontal = Gutter),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            BrandMark(56.dp)
            Text("Cranium", Modifier.semantics { heading() }, style = ConsoleType.pageTitle.copy(fontSize = 26.sp), color = colors.ink)
            Text(CustomerText.STUDIO, style = ConsoleType.note, color = colors.ink3)
            Spacer(Modifier.height(8.dp))
            if (gate.line != null) {
                Row(Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    GlyphIcon(Glyph.ALERT, Modifier.padding(top = 2.dp), tint = colors.warn)
                    Text(gate.line, style = ConsoleType.small, color = colors.ink)
                }
            }
            if (gate.busy) {
                CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp, color = colors.accent)
            } else {
                ConsoleButton(FingerprintWords.UNLOCK, vm::unlock, Modifier.fillMaxWidth(), kind = ButtonKind.PRIMARY, glyph = Glyph.FINGERPRINT)
                ConsoleButton(FingerprintWords.PASSWORD, vm::signInWithPassword, Modifier.fillMaxWidth(), kind = ButtonKind.QUIET)
            }
        }
    }
}
