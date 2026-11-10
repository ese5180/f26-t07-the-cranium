package com.craniumiot.cranium.core

/**
 * Every word of the customer screens, in one place: the customer site's own
 * (cloud/web/src/customer/assets/customer-views.js and customer.js), word for word, so that the
 * app and the website say the same. CustomerWordsTest finds each of [WEBSITE] in those files; the
 * few the website has no counterpart for are in [PHONE_ONLY].
 */
object CustomerText {
    // The sections (customer-views.js SECTIONS) and the frame.
    const val OVERVIEW = "Overview"
    const val DEVICES = "Devices"
    const val MIXES = "Mixes"
    const val ACCOUNT = "Account"
    const val HELP = "Help"
    const val STUDIO = "Your studio"
    const val ADMIN_MODE = "Admin mode"
    const val ROLE_MANAGER = "Admin · release manager"
    const val ROLE_VIEWER = "Admin · viewer"
    const val FOOT = "Your music stays on your deck: this site only shows how your boards are."
    const val TRY_AGAIN = "Try again"
    const val SIGN_OUT = "Sign out"

    // Overview.
    const val OVERVIEW_EYEBROW = "Your boards, at a glance"
    const val WELCOME = "Welcome back."
    const val OVERVIEW_LEDE = "How your Cranium is doing, and what it did lately."
    const val ONLINE_NOW = "Online now"
    const val EACH_REPORTS = "Each board reports every 30 s"
    const val BOARDS = "Boards"
    const val ON_ACCOUNT = "On your account"
    const val FIRMWARE = "Firmware"
    const val NOT_SAME = "Not every board is on the same one"
    const val KEPT_UP = "Kept up to date by Cranium"
    const val LAST_HEARD = "Last heard from"
    const val NO_REPORT = "No report yet"
    const val YOUR_BOARDS = "Your boards"
    const val ALL_DEVICES = "All devices"
    const val NO_BOARDS = "No boards on your account yet."
    const val NO_BOARDS_TEXT = "Once Cranium gives you a board, it shows here."
    const val FIRMWARE_NOT_REPORTED = "Firmware not reported"
    const val NOT_HEARD_YET = "Not heard from yet"
    const val A_BOARD = "A board"
    const val LATELY = "Lately"
    const val NOTHING_WEEK = "Nothing in the last week."
    const val TEASER_EYEBROW = "After the last track"
    const val TEASER_TITLE = "Good mixes happen. Great ones get remembered."
    const val TEASER_TEXT = "Your sessions, your transitions and the tracks you keep coming back to will live here, once your board " +
        "can tell this site what you played. That part is not built yet."
    const val WHAT_IS_COMING = "What is coming"
    const val WHAT_YOUR_BOARDS_DID = "what your boards did"
    const val THE_BOARDS = "your boards"

    // The admin's overview.
    const val ADMIN = "Admin"
    const val ADMIN_TITLE = "Signed in as an admin."
    const val ADMIN_LEDE = "Your account on the console."
    const val ADMIN_PANEL_TITLE = "The console, for every board."
    const val ADMIN_PANEL_TEXT = "Admin mode opens the firmware console here, with the sign-in you just made: the boards, firmware, " +
        "deployments, the activity log, and the Customers page, where you invite customers and give them their boards."
    const val OPEN_ADMIN_MODE = "Open admin mode"
    const val WHAT_CUSTOMERS_SEE = "What customers see"
    const val WHAT_CUSTOMERS_SEE_TEXT = "A customer signs in on this site with the account you invite them to, and sees their own boards: whether each " +
        "is online, the firmware it runs, when it was last heard from and how its updates went. Never another " +
        "customer, the activity log, firmware or anything of AWS."

    // Devices and a board.
    const val DEVICES_LEDE = "Every Cranium on your account, as it last reported."
    const val BOARD = "Board"
    const val STATE = "State"
    const val UPDATE = "Update"
    const val THE_BOARD = "the board"
    const val NO_BOARD_HERE = "There is no board of yours here."
    const val NO_BOARD_HERE_TEXT = "It may have been moved to another account."
    const val HOW_IT_IS = "How it is"
    const val ON_TRIAL = "On trial"
    const val NOT_REPORTED_YET = "Not reported yet"
    const val NOT_YET = "Not yet"
    const val WIFI_SIGNAL = "Wi-Fi signal"
    const val NOT_REPORTED = "Not reported"
    const val RUNNING_FOR = "Running for"
    const val LOCATION = "Location"
    const val LOCATION_NOT_REPORTED = "Not reported: boards cannot tell where they are yet."
    const val YOURS_SINCE = "Yours since"
    const val UPDATES_NOTE = "Cranium sends firmware updates, signed, and the board checks each one before it keeps it. " +
        "There is nothing for you to do; a board installs an update while it is on and online."
    const val WHAT_IT_DID = "What it did"
    const val NOTHING_30_DAYS = "Nothing in the last 30 days."

    // Mixes (customer-views.js MIX_WORDS).
    const val MIXES_EYEBROW = "Your mixes, remembered"
    const val MIXES_TITLE = "Find your next great mix."
    const val MIXES_LEDE = "A home for the tracks, the transitions and the happy accidents of every set."
    const val NOT_BUILT = "Not built yet"
    const val WHY_EMPTY = "Why it is empty: your board does not send what you play. That needs the Raspberry Pi to record the tracks Mixxx " +
        "plays and the board to pass them on, and neither is built yet. Nothing here is made up in the meantime."
    const val MIXES_NOTE = "When it is built, only what you played is kept: track names and times, never the music itself."

    /** A tab of Mixes: its label, its title and what it will hold. */
    data class MixTab(val id: String, val label: String, val title: String, val text: String)

    val MIX_TABS: List<MixTab> = listOf(
        MixTab(
            "sessions", "Sessions", "Every set has a story.",
            "Each time you play, a session: when it started, how long it ran, and the tracks in the order you played them, deck by deck.",
        ),
        MixTab("transitions", "Transitions", "The space between tracks.", "Which tracks you put together, and how long both decks played at once."),
        MixTab(
            "library", "Track library", "Your rotation, revealed.",
            "The tracks you keep coming back to, across every session, ranked by how often you play them.",
        ),
        MixTab(
            "listening", "Your listening", "Your week on the decks.",
            "How long you played this week and last, which days were busy, and the tracks and artists you play most.",
        ),
        MixTab("moments", "Saved moments", "Keep the good ones.", "A note on a transition worth trying again, kept with your account for your next set."),
    )

    // Account.
    const val ACCOUNT_LEDE = "Your sign-in, and how it is protected."
    const val YOUR_ACCOUNT = "Your account"
    const val THE_ACCOUNT = "your account"
    const val SIGNED_IN_AS = "Signed in as"
    const val EMAIL = "E-mail"
    const val NAME = "Name"
    const val NOT_GIVEN = "Not given"
    const val SESSION = "Session"
    const val EMAIL_NOTE = "Your e-mail address is your sign-in name. To change it, ask Cranium."
    const val PASSWORD = "Password"
    const val CURRENT_PASSWORD = "Current password"
    const val NEW_PASSWORD = "New password"
    const val NEW_PASSWORD_HINT = "At least 10 characters. A few words in a row make a good one."
    const val NEW_PASSWORD_AGAIN = "New password again"
    const val PASSWORD_CHANGED = "Your password is changed."
    const val CHANGE_PASSWORD = "Change password"
    const val SAVING = "Saving…"
    const val TWO_STEP = "Two-step sign-in"
    const val ON = "On"
    const val OFF = "Off"
    const val TWO_STEP_ON_TEXT = "Each sign-in asks for your password and a code from your authenticator app."
    const val TWO_STEP_OFF_TEXT = "Ask for a code from an authenticator app on your phone at each sign-in, as well as your password. " +
        "Someone who learns your password still cannot sign in."
    const val TURN_ON = "Turn on"
    const val STARTING = "Starting…"
    const val TURN_OFF = "Turn off"
    const val STEP_APP = "Open an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator or 1Password, and add an account."
    const val STEP_KEY = "Choose to enter a setup key, and type this one. Its time-based codes are what Cranium asks for."
    const val COPY_KEY = "Copy the key"
    const val OPEN_IN_APP = "Open in an authenticator app on this phone"
    const val STEP_CODE = "Type the six digits the app shows now."
    const val CODE_FROM_APP = "Code from your authenticator app"
    const val NEW_CODE_EVERY = "A new code comes every 30 seconds."
    const val TURN_ON_TWO_STEP = "Turn on two-step sign-in"
    const val CHECKING = "Checking…"
    const val NOT_NOW = "Not now"
    const val OFF_WARNING = "Sign-in will ask for your password only. Anyone who learns it can then sign in as you."
    const val TURNING_OFF = "Turning it off…"
    const val TURN_IT_OFF = "Turn it off"
    const val KEEP_IT_ON = "Keep it on"
    const val TWO_STEP_IS_ON = "Two-step sign-in is on. From your next sign-in, Cranium asks for a code too."
    const val TWO_STEP_IS_OFF = "Two-step sign-in is off."
    const val KEY_COPIED = "The setup key is copied."

    // Help (customer-views.js HELP).
    const val HELP_EYEBROW = "Help and support"
    const val HELP_TITLE = "How can we help?"
    const val HELP_LEDE = "Answers about your board, its updates and your account."
    const val STILL_STUCK = "Still stuck?"
    const val NO_SUPPORT = "A support address for customers is not set up yet. Until it is, ask the person at Cranium who gave you your account."

    class Question(val question: String, val answer: String)

    class HelpSection(val title: String, val questions: List<Question>)

    val HELP_SECTIONS: List<HelpSection> = listOf(
        HelpSection(
            "Your board",
            listOf(
                Question(
                    "What does Online mean?",
                    "A board that is on and connected reports to Cranium every 30 seconds. It counts as online for 90 seconds after a report, so a board that was just switched off still shows online for a moment, and then offline.",
                ),
                Question(
                    "My board shows Offline.",
                    "Check that it is switched on and that its Wi-Fi works. It reports again within 30 seconds of getting back online. A board that is restarting after an update can be quiet for a few minutes.",
                ),
                Question(
                    "What is the name of my board?",
                    "The name Cranium gave it when it was put on your account. Its own device name, which it was set up with, is shown beside it when it is different.",
                ),
            ),
        ),
        HelpSection(
            "Updates",
            listOf(
                Question(
                    "Do I have to update my board?",
                    "No. Cranium sends firmware updates, and the board installs them while it is on and online. You can watch it happen on the board's page.",
                ),
                Question(
                    "Is an update safe?",
                    "Every update is signed by Cranium, and the board checks the signature before it installs it. A new update runs on trial: if it cannot reach Cranium within 5 minutes, the board goes back to the firmware it had, by itself.",
                ),
                Question(
                    "My board says it waits for Button 1.",
                    "Older firmware asks for a press of Button 1 on the board before it installs an update. Press it, and the update goes ahead.",
                ),
            ),
        ),
        HelpSection(
            "Your account",
            listOf(
                Question(
                    "How do I get an account?",
                    "Cranium makes it and e-mails you an invitation with a temporary password. There is no sign-up. The first time you sign in, you choose your own password.",
                ),
                Question(
                    "I forgot my password.",
                    "Choose \"Forgot your password?\" on the sign-in page. Cranium e-mails a code to your address, and you choose a new password with it.",
                ),
                Question(
                    "How do I make my account safer?",
                    "Turn on two-step sign-in on your Account page. Each sign-in then also asks for a code from an authenticator app on your phone.",
                ),
                Question("Who can see my boards?", "You, and the people at Cranium who look after the boards. No other customer can."),
            ),
        ),
        HelpSection(
            "Your mixes",
            listOf(
                Question(
                    "Where are my sessions and tracks?",
                    "Your board sends its sessions once its firmware supports it (firmware 1.18.0, not yet released). Until then the site shows the demo, made-up sessions marked as such, or the journal you import, kept on this device only.",
                ),
            ),
        ),
    )

    // Signing in (customer-views.js signInView, forgotView).
    const val SIGN_IN = "Sign in"
    const val SIGN_IN_LEAD = "With the e-mail address and the password of your Cranium account."
    const val GATE_FOOT = "See your boards, how they are and what they did."
    const val EMAIL_ADDRESS = "E-mail address"
    const val CONTINUE = "Continue"
    const val FORGOT = "Forgot your password?"
    const val ENTER_CODE = "Enter the code"
    const val CODE_HINT = "The six digits it shows now. The code goes in by itself once the last digit is typed."
    const val START_AGAIN = "Start again"
    const val CHOOSE_PASSWORD = "Choose your password"
    const val WELCOME_NEW = "Welcome. Your invitation's password works once: choose your own now."
    const val AT_LEAST = "At least 10 characters."
    const val SAVE_AND_SIGN_IN = "Save and sign in"
    const val ONE_MORE_STEP = "One more step"
    const val ELSEWHERE = "Your account needs a new password first. Choose one with \"Forgot your password?\"."
    const val CHOOSE_NEW = "Choose a new password"
    const val A_NEW_PASSWORD = "A new password"
    const val FORGOT_LEAD = "Type the address you sign in with. Cranium e-mails a code to it, and you choose a new password with the code."
    const val SEND_CODE = "Send me a code"
    const val SENDING = "Sending…"
    const val CODE_FROM_EMAIL = "Code from the e-mail"
    const val CODE_FROM_EMAIL_HINT = "Six digits, in the e-mail from Cranium."
    const val SET_PASSWORD = "Set the new password"
    const val SEND_ANOTHER = "Send another code"
    const val DONE = "Done"
    const val CHANGED_SIGN_IN = "Your password is changed. Sign in with it now."
    const val BACK_TO_SIGN_IN = "Back to sign-in"
    const val SESSION_ENDED = "Your session has ended. Sign in again to carry on."
    // From the console's own page (views.js), where admin mode is left.
    const val LEAVE_ADMIN_MODE = "Leave admin mode"

    // The phone's own: there is no tab of a website to end, and a build may lack the customer pool.
    const val SIGN_OUT_TEXT = "Ends your session on this phone."
    const val NOT_SET_UP = "Customer sign-in is not set up in this build. Run apps/configure.sh once the stack has the customer pool, then build again."
    const val FINGERPRINT_OFFER = "Cranium then opens with your fingerprint for up to 30 days, instead of your password."
    const val SESSION_FINGERPRINT = "Opens with your fingerprint for up to 30 days from your sign-in"
    const val SESSION_HOUR = "About an hour from your sign-in, then sign in again"
    const val NO_AUTHENTICATOR = "No app on this phone opens it. Copy the key, and type it into the authenticator app."
    const val PROMPT_SUBTITLE = "For up to 30 days, instead of your password"
    const val FINGERPRINT_SETTING_OFF = "Instead of your password, for up to 30 days"

    // Words made of others.
    fun hello(name: String) = "Hello, $name."
    fun firmwareOf(version: String) = "Firmware $version"
    fun heardFrom(ago: String) = "Heard from $ago"
    fun boardNamed(name: String) = "Board $name"
    fun updating(count: Int) = "${Words.plural(count, "board")} updating"
    fun versions(count: Int) = Words.plural(count, "version")
    fun signingInAs(email: String) = "Signing in as $email."
    fun codeOnItsWay(email: String) = "If $email has an account, a code is on its way to it. It can take a minute."
    fun couldNotLoad(what: String) = "Could not load $what. "
    fun loading(what: String) = "Loading $what…"
    fun adminLede(email: String, canWrite: Boolean) = "$email · ${if (canWrite) "release manager" else "viewer"}"

    /** The words above that are the website's, each of which CustomerWordsTest finds there. */
    val WEBSITE: List<String> = listOf(
        OVERVIEW, DEVICES, MIXES, ACCOUNT, HELP, STUDIO, ADMIN_MODE, ROLE_MANAGER, ROLE_VIEWER, FOOT, TRY_AGAIN, SIGN_OUT,
        OVERVIEW_EYEBROW, WELCOME, OVERVIEW_LEDE, ONLINE_NOW, EACH_REPORTS, BOARDS, ON_ACCOUNT, FIRMWARE, NOT_SAME, KEPT_UP,
        LAST_HEARD, NO_REPORT, YOUR_BOARDS, ALL_DEVICES, NO_BOARDS, NO_BOARDS_TEXT, FIRMWARE_NOT_REPORTED, NOT_HEARD_YET, A_BOARD,
        LATELY, NOTHING_WEEK, TEASER_EYEBROW, TEASER_TITLE, TEASER_TEXT, WHAT_IS_COMING, WHAT_YOUR_BOARDS_DID, THE_BOARDS,
        // The admin's overview on the site is now the customer's own, with admin mode in place of the boards
        // (console 2.4.4); the classic screens keep their own admin words, which the site no longer has.
        ADMIN, ADMIN_PANEL_TITLE, OPEN_ADMIN_MODE,
        DEVICES_LEDE, BOARD, STATE, UPDATE, THE_BOARD, NO_BOARD_HERE, NO_BOARD_HERE_TEXT, HOW_IT_IS, ON_TRIAL, NOT_REPORTED_YET, NOT_YET,
        WIFI_SIGNAL, NOT_REPORTED, RUNNING_FOR, LOCATION, LOCATION_NOT_REPORTED, YOURS_SINCE, UPDATES_NOTE, WHAT_IT_DID, NOTHING_30_DAYS,
        MIXES_EYEBROW, MIXES_TITLE, MIXES_LEDE, NOT_BUILT, WHY_EMPTY, MIXES_NOTE,
        ACCOUNT_LEDE, YOUR_ACCOUNT, THE_ACCOUNT, SIGNED_IN_AS, EMAIL, NAME, NOT_GIVEN, SESSION, EMAIL_NOTE, PASSWORD, CURRENT_PASSWORD,
        NEW_PASSWORD, NEW_PASSWORD_HINT, NEW_PASSWORD_AGAIN, PASSWORD_CHANGED, CHANGE_PASSWORD, SAVING, TWO_STEP, ON, OFF,
        TWO_STEP_ON_TEXT, TWO_STEP_OFF_TEXT, TURN_ON, STARTING, TURN_OFF, STEP_APP, STEP_KEY, COPY_KEY, OPEN_IN_APP, STEP_CODE,
        CODE_FROM_APP, NEW_CODE_EVERY, TURN_ON_TWO_STEP, CHECKING, NOT_NOW, OFF_WARNING, TURNING_OFF, TURN_IT_OFF, KEEP_IT_ON,
        TWO_STEP_IS_ON, TWO_STEP_IS_OFF, KEY_COPIED,
        HELP_EYEBROW, HELP_TITLE, HELP_LEDE, STILL_STUCK, NO_SUPPORT,
        SIGN_IN, SIGN_IN_LEAD, GATE_FOOT, EMAIL_ADDRESS, CONTINUE, FORGOT, ENTER_CODE, CODE_HINT,
        START_AGAIN, CHOOSE_PASSWORD, WELCOME_NEW, AT_LEAST, SAVE_AND_SIGN_IN, ONE_MORE_STEP, ELSEWHERE, CHOOSE_NEW, A_NEW_PASSWORD,
        FORGOT_LEAD, SEND_CODE, SENDING, CODE_FROM_EMAIL, CODE_FROM_EMAIL_HINT, SET_PASSWORD, SEND_ANOTHER, DONE, CHANGED_SIGN_IN,
        BACK_TO_SIGN_IN, SESSION_ENDED, LEAVE_ADMIN_MODE,
    ) + MIX_TABS.flatMap { listOf(it.label, it.title, it.text) } +
        HELP_SECTIONS.flatMap { section -> listOf(section.title) + section.questions.flatMap { listOf(it.question, it.answer) } }

    /** The phone's own words, which the website has no counterpart for. */
    val PHONE_ONLY: List<String> = listOf(
        SIGN_OUT_TEXT, NOT_SET_UP, FINGERPRINT_OFFER, SESSION_FINGERPRINT, SESSION_HOUR, NO_AUTHENTICATOR, PROMPT_SUBTITLE,
        FINGERPRINT_SETTING_OFF,
    )
}
