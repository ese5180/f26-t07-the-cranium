package com.craniumiot.cranium.ui

import com.craniumiot.cranium.core.ApiToken
import com.craniumiot.cranium.core.AuditEntry
import com.craniumiot.cranium.core.AuditPage
import com.craniumiot.cranium.core.BoardEvent
import com.craniumiot.cranium.core.CacheSummary
import com.craniumiot.cranium.core.Deployment
import com.craniumiot.cranium.core.DeploymentSummary
import com.craniumiot.cranium.core.Device
import com.craniumiot.cranium.core.DeviceDetail
import com.craniumiot.cranium.core.DeviceList
import com.craniumiot.cranium.core.Glyph
import com.craniumiot.cranium.core.HistoryRead
import com.craniumiot.cranium.core.Me
import com.craniumiot.cranium.core.NewToken
import com.craniumiot.cranium.core.Release
import com.craniumiot.cranium.core.ReleaseList
import com.craniumiot.cranium.core.BoardLine
import com.craniumiot.cranium.core.LinePage
import com.craniumiot.cranium.core.Samples
import com.craniumiot.cranium.core.Telemetry
import com.craniumiot.cranium.core.TokenList
import com.craniumiot.cranium.core.Tone
import com.craniumiot.cranium.core.UploadReview

/** Something read from the console: the last value, the last failure, when it was read, and whether it is being read. */
data class Resource<T>(val value: T? = null, val error: Throwable? = null, val loadedAt: Long = 0, val loading: Boolean = false)

/** The sections of the bottom bar. More holds the rest of the website's sections. */
enum class Tab(val label: String, val glyph: Glyph) {
    OVERVIEW("Overview", Glyph.HOME),
    BOARDS("Boards", Glyph.CHIP),
    FIRMWARE("Firmware", Glyph.PACKAGE),
    EVENTS("Events", Glyph.PULSE),
    MORE("More", Glyph.MORE),
}

/** The pages of the app: the website's routes, and the update over Bluetooth. */
sealed interface Route {
    val key: String

    data object Overview : Route { override val key = "overview" }
    data object Boards : Route { override val key = "devices" }
    data class Board(val thing: String) : Route { override val key = "device/$thing" }
    data object Firmware : Route { override val key = "firmware" }
    data object Events : Route { override val key = "events" }
    data object More : Route { override val key = "more" }
    data object Deployments : Route { override val key = "deployments" }
    data class DeploymentPage(val id: String) : Route { override val key = "deployment/$id" }
    data object Activity : Route { override val key = "activity" }
    data object Tokens : Route { override val key = "tokens" }
    data object History : Route { override val key = "history" }
    data object Serial : Route { override val key = "serial" }
    data object Account : Route { override val key = "account" }
    data class Bluetooth(val version: String?) : Route { override val key = "bluetooth" }
    data class Release(val version: String) : Route { override val key = "release/$version" }
    data object Upload : Route { override val key = "upload" }
    data class BoardPage(val thing: String, val part: BoardPart) : Route { override val key = "device/$thing/${part.name}" }
    data class ExecutionPage(val id: String, val thing: String) : Route { override val key = "deployment/$id/$thing" }
    data class ActivityEntry(val id: String) : Route { override val key = "activity/$id" }
    data class TokenPage(val id: String) : Route { override val key = "token/$id" }
    data object SearchPage : Route { override val key = "search" }
    data class HelpPage(val topic: String?) : Route { override val key = "help/${topic.orEmpty()}" }
}

/** The parts of a board's page, each a screen of its own. */
enum class BoardPart(val title: String) {
    FIRMWARE("Firmware and slots"),
    DIAGNOSTICS("Diagnostics"),
    CHARTS("Charts"),
    BLUETOOTH("Bluetooth"),
    HISTORY("Update history"),
}

/** The app's own sign-in screen: the e-mail address and password, then the code. Never the password. */
enum class SignInPhase { PASSWORD, CODE }

data class SignInForm(
    val phase: SignInPhase = SignInPhase.PASSWORD,
    val email: String = "",
    /** The digits of the code so far, at most six. */
    val code: String = "",
    val busy: Boolean = false,
    /** A key of SignInWords.WORDS. */
    val problem: String? = null,
    /** Counts the answers, so that the same problem twice is said twice. */
    val tries: Int = 0,
    /** For a change that needs a fresh sign-in, over the console. */
    val fresh: Boolean = false,
    /** The address of the account that is signed in, which a fresh sign-in keeps. */
    val emailFixed: Boolean = false,
    /** On the way to the AWS sign-in page, and why ("" for no reason given). */
    val leaving: String? = null,
)

/** Where the person is: a tab, and in each tab the pages they went through. */
data class Nav(
    val tab: Tab = Tab.OVERVIEW,
    val stacks: Map<Tab, List<Route>> = mapOf(
        Tab.OVERVIEW to listOf(Route.Overview),
        Tab.BOARDS to listOf(Route.Boards),
        Tab.FIRMWARE to listOf(Route.Firmware),
        Tab.EVENTS to listOf(Route.Events),
        Tab.MORE to listOf(Route.More),
    ),
) {
    val route: Route get() = stacks.getValue(tab).last()
    val canGoBack: Boolean get() = stacks.getValue(tab).size > 1 || tab != Tab.OVERVIEW
}

/** Before the console can be shown. */
sealed interface Gate {
    data object Starting : Gate
    data class SignIn(val busy: String? = null, val notice: String? = null) : Gate

    /** A sign-in is kept behind the fingerprint: nothing of the console until it passes. */
    data class Locked(val line: String? = null, val busy: Boolean = false) : Gate
    data object Ready : Gate
}

/** What a fingerprint prompt is for. */
enum class PromptPurpose {
    /** Open the sign-in kept behind the fingerprint. */
    UNLOCK,

    /** Turn fingerprint unlock on: from the offer, or the Account screen. */
    ENROL,

    /** Keep a new full sign-in behind the fingerprint, which was on already. */
    REKEY,
}

/** A BiometricPrompt the screen is to show, with the cipher it authorises. */
class PromptRequest(val id: Long, val purpose: PromptPurpose, val cipher: javax.crypto.Cipher) {
    val title: String get() = when (purpose) {
        PromptPurpose.UNLOCK -> "Unlock Cranium"
        PromptPurpose.ENROL -> "Use your fingerprint for Cranium"
        PromptPurpose.REKEY -> "Keep this sign-in behind your fingerprint"
    }
    val subtitle: String get() = when (purpose) {
        PromptPurpose.UNLOCK -> "Touch the fingerprint sensor"
        PromptPurpose.ENROL, PromptPurpose.REKEY -> "For up to 30 days, instead of your password and code"
    }
    val negative: String get() = when (purpose) {
        PromptPurpose.UNLOCK -> "Sign in with password"
        PromptPurpose.ENROL -> "Cancel"
        PromptPurpose.REKEY -> "Not now"
    }
}

/** Fingerprint unlock, for the Account screen. */
data class FingerprintUi(
    val state: com.craniumiot.cranium.core.BiometricState = com.craniumiot.cranium.core.BiometricState.UNAVAILABLE,
    val on: Boolean = false,
    val busy: Boolean = false,
)

/** What the window hides: nothing; the recents thumbnail; or everything, screenshots included (FLAG_SECURE). */
enum class WindowGuard { NONE, NO_RECENTS, SECURE }

/** A message at the foot of the screen, for as long as it takes to read it. */
data class Toast(val id: Long, val text: String, val tone: Tone = Tone.GOOD)

/** The Events page: its range, its filters and what was read. */
data class EventsQuery(val from: String, val to: String, val thing: String?, val kinds: List<String>?)

data class EventsData(
    val events: List<BoardEvent>,
    val cursor: String?,
    val span: Telemetry.TimeSpan,
    val query: EventsQuery,
    /** The activity log in the range, for the Console lane; null while that lane is off. */
    val audit: List<AuditEntry>?,
    val auditCut: Boolean,
    val pages: Int,
    /** The board log of the range; null while it is hidden. */
    val log: LogData? = null,
)

/** What the board log was asked for, a page at a time. */
data class LogQuery(val from: String, val to: String, val thing: String?, val kinds: List<String>?, val tags: List<String>?)

/** The board log of the range: its lines, or why it could not be read, which leaves the events as they are. */
data class LogData(
    val lines: List<BoardLine> = emptyList(),
    val cursor: String? = null,
    val query: LogQuery? = null,
    val pages: Int = 1,
    val error: Throwable? = null,
)

data class EventsPage(
    val range: Telemetry.Range = Telemetry.Range.Last("24h"),
    val zooms: List<Telemetry.Range> = emptyList(),
    val thing: String = "",
    val hidden: Set<String> = emptySet(),
    val data: Resource<EventsData> = Resource(),
    val moreLoading: Boolean = false,
    val moreError: Throwable? = null,
    val selected: String? = null,
    /** The board log: shown or not, and the one source it is narrowed to ("" for all of them). */
    val log: Boolean = true,
    val tag: String = "",
    val linesMoreLoading: Boolean = false,
    val linesMoreError: Throwable? = null,
)

/** Everything read from the console, as the website's state holds it. */
data class Store(
    val me: Me? = null,
    val devices: Resource<DeviceList> = Resource(),
    val firmware: Resource<ReleaseList> = Resource(),
    val deployments: Resource<List<DeploymentSummary>> = Resource(),
    val recent: Resource<AuditPage> = Resource(),
    val audit: Resource<AuditPage> = Resource(),
    val auditMoreLoading: Boolean = false,
    val auditMoreError: Throwable? = null,
    val tokens: Resource<TokenList> = Resource(),
    val history: Resource<HistoryRead> = Resource(),
    val deviceDetails: Map<String, Resource<DeviceDetail>> = emptyMap(),
    val deploymentDetails: Map<String, Resource<Deployment>> = emptyMap(),
    val samples: Map<String, Resource<Samples>> = emptyMap(),
    /** Each board's newest lines of its own log, for its page. */
    val boardLines: Map<String, Resource<LinePage>> = emptyMap(),
    val events: EventsPage = EventsPage(),
    /** The checked images kept on the phone (docs/mobile-apps.md, "Cache"). */
    val cache: CacheSummary = CacheSummary.EMPTY,
) {
    val deviceList: List<Device>? get() = devices.value?.devices
    val releases: List<Release>? get() = firmware.value?.releases
}

/** A board that has an update open, as its own history says. */
data class BusyInfo(val deployment: String, val version: String?)

/** The dialogs that change something. Each keeps what the person entered until it closes. */
sealed interface DialogState {
    val sending: Boolean
    val error: Throwable?

    data class Deploy(
        val step: Int,
        val version: String?,
        val things: Set<String> = emptySet(),
        val chosenByHand: Boolean = false,
        val note: String = "",
        val busy: Map<String, BusyInfo> = emptyMap(),
        val releases: List<Release>? = null,
        val devices: List<Device>? = null,
        val loading: Boolean = true,
        val loadError: Throwable? = null,
        override val sending: Boolean = false,
        override val error: Throwable? = null,
        /** The release this dialog was opened for, revoked since. */
        val gone: String? = null,
    ) : DialogState

    data class Cancel(
        val id: String,
        val force: Boolean = false,
        override val sending: Boolean = false,
        override val error: Throwable? = null,
    ) : DialogState

    data class Revoke(
        val version: String,
        val reason: String = "",
        override val sending: Boolean = false,
        override val error: Throwable? = null,
    ) : DialogState

    /** A release's note: one line of up to 500 characters, empty for none. */
    data class Notes(
        val version: String,
        val notes: String,
        override val sending: Boolean = false,
        override val error: Throwable? = null,
    ) : DialogState

    data class CreateToken(
        val name: String = "",
        val days: String = "30",
        override val sending: Boolean = false,
        override val error: Throwable? = null,
        /** The token, shown once. Gone with the dialog. */
        val made: NewToken? = null,
    ) : DialogState

    data class RevokeToken(
        val token: ApiToken,
        override val sending: Boolean = false,
        override val error: Throwable? = null,
    ) : DialogState
}

/** Where a chosen file stands on its way to the boards. */
enum class UploadStep { IDLE, READING, READY, SENDING, CHECKING, DONE, REFUSED }

data class UploadState(
    val step: UploadStep = UploadStep.IDLE,
    val name: String = "",
    val recordedAs: String = "",
    val size: Long = 0,
    val digest: String = "",
    val header: UploadReview.Header? = null,
    val notes: String = "",
    val sent: Float = 0f,
    val error: Throwable? = null,
    val release: Release? = null,
) {
    /** A chosen file is in hand: being read, waiting to be sent, on its way or refused. */
    val inHand: Boolean get() = step != UploadStep.IDLE && step != UploadStep.DONE
}
