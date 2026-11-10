package com.craniumiot.cranium.core

/** One fact of a log entry, in the console's words. */
data class AuditFact(
    val key: String,
    val label: String,
    val value: String,
    val code: Boolean,
    /** True when the label reads on into the value ("Size 1,264 bytes"); false for "Reason: …". */
    val phrase: Boolean,
    /** A refusal in words, where there are words for its code. */
    val words: String? = null,
)

/** Where a link of the log leads, inside the app. */
sealed class LogLink {
    data class ToDeployment(val id: String) : LogLink()
    data object ToFirmware : LogLink()
}

/**
 * One line of the activity log (core.js describeAudit): what was done, to what, and how it ended
 * if not well. [verb] comes before the [label] and [tail] after it. A deployment is called by its
 * version; its id goes to [facts]. [boards] are the thing names of the boards a deployment went to,
 * as far as the entry names them, and [boardCount] how many there were ([AuditText.boards] puts them
 * into words). [byName] says that the label is a board's own name, its device ID.
 */
data class AuditWords(
    val glyph: Glyph,
    val verb: String,
    val label: String,
    val tail: String,
    val outcome: StateWords?,
    val link: LogLink?,
    val facts: List<AuditFact>,
    val scripted: Boolean,
    val boards: List<String> = emptyList(),
    val boardCount: Int = 0,
    val byName: Boolean = false,
)

/** The activity log in the console's words: a port of core.js describeAudit, auditBoards and auditSentence. */
object AuditText {
    /**
     * What each action is called. `done` and `tried` read on into the entry's label; where `{}`
     * stands in them the label goes there, and the words after it follow it. `doneAlone` and
     * `triedAlone` are the whole sentence for an entry without a label.
     */
    private data class Action(
        val done: String,
        val tried: String,
        val triedAlone: String,
        val glyph: Glyph,
        val doneAlone: String? = null,
    )

    private val ACTIONS: Map<String, Action> = mapOf(
        "firmware.upload" to Action("uploaded firmware", "tried to upload", "tried to upload a file", Glyph.UPLOAD),
        "firmware.revoke" to Action("revoked firmware", "tried to revoke firmware", "tried to revoke a release", Glyph.BAN),
        // Raspberry Pi images (console 2.26.0).
        "pi_image.upload" to Action(
            "began uploading Pi image", "tried to upload Pi image", "tried to upload a Pi image", Glyph.UPLOAD,
        ),
        "pi_image.complete" to Action(
            "finished uploading Pi image", "tried to finish uploading Pi image", "tried to finish a Pi image upload", Glyph.CHECK,
        ),
        "pi_image.revoke" to Action("revoked Pi image", "tried to revoke Pi image", "tried to revoke a Pi image", Glyph.BAN),
        "deployment.create" to Action(
            "deployed", "tried to deploy", "tried to start a deployment", Glyph.SEND, doneAlone = "started a deployment",
        ),
        "deployment.cancel" to Action(
            "cancelled the deployment of", "tried to cancel the deployment of", "tried to cancel a deployment", Glyph.STOP,
        ),
        // From the phone apps, for an update over Bluetooth.
        "firmware.download" to Action(
            "downloaded {} to a phone", "tried to download", "tried to download firmware", Glyph.DOWNLOAD,
            doneAlone = "downloaded firmware to a phone",
        ),
        "pairing.read" to Action(
            "read the Bluetooth passkey of", "tried to read the Bluetooth passkey of", "tried to read a Bluetooth passkey", Glyph.SHIELD,
        ),
        // The check a phone makes right before it sends a release to a board over Bluetooth.
        "firmware.bluetooth_send" to Action(
            "was cleared to send {} over Bluetooth", "tried to send {} over Bluetooth", "tried to send firmware over Bluetooth",
            Glyph.CHIP, doneAlone = "was cleared to send firmware over Bluetooth",
        ),
        "token.create" to Action("made API token", "tried to make API token", "tried to make an API token", Glyph.KEY),
        "token.revoke" to Action("revoked API token", "tried to revoke API token", "tried to revoke an API token", Glyph.KEY),
        // A sign-in with password and code, on the website or a phone app (SIGNED_IN_ON).
        "account.sign_in" to Action("signed in", "tried to sign in", "tried to sign in", Glyph.USER),
        // A command that changed a board at its serial console, named by the board's device ID (SERIAL_WORDS).
        "serial.command" to Action(
            "ran a command on {} over USB", "tried to put on record a command on {} over USB",
            "tried to put on record a command run over USB", Glyph.CHIP, doneAlone = "ran a command on a board over USB",
        ),
        // A command sent to a board over the internet (COMMAND_WORDS), and a person's own e-mail alerts.
        "board.command" to Action("sent a command to", "tried to send a command to", "tried to send a command to a board", Glyph.LOCATE),
        "alert.subscribe" to Action(
            "asked for e-mail alerts at", "tried to ask for e-mail alerts at", "tried to ask for e-mail alerts", Glyph.BELL,
        ),
        "alert.unsubscribe" to Action(
            "stopped the e-mail alerts to", "tried to stop the e-mail alerts to", "tried to stop e-mail alerts", Glyph.BELL,
        ),
        "alert.rules" to Action(
            "changed the alert rules", "tried to change the alert rules", "tried to change the alert rules", Glyph.BELL,
            doneAlone = "changed the alert rules",
        ),
        // The fleet (docs/fleet.md): groups, staged rollouts, a phone's sighting, a release's note.
        "group.create" to Action("made the group", "tried to make the group", "tried to make a group", Glyph.LIST),
        "group.update" to Action("changed the group", "tried to change the group", "tried to change a group", Glyph.LIST),
        "group.delete" to Action("deleted the group", "tried to delete the group", "tried to delete a group", Glyph.LIST),
        "group.rollback" to Action("rolled back the group", "tried to roll back the group", "tried to roll back a group", Glyph.RESTART),
        "rollout.create" to Action(
            "started a staged rollout of", "tried to start a staged rollout of", "tried to start a staged rollout", Glyph.SEND,
            doneAlone = "started a staged rollout",
        ),
        "rollout.cancel" to Action(
            "cancelled the staged rollout", "tried to cancel the staged rollout", "tried to cancel a staged rollout", Glyph.STOP,
        ),
        // The console's own, when a canary has confirmed or a rollout stopped.
        "rollout.advance" to Action(
            "went on with the staged rollout", "could not go on with the staged rollout", "could not go on with a staged rollout",
            Glyph.SEND,
        ),
        "rollout.stop" to Action(
            "stopped the staged rollout", "could not stop the staged rollout", "could not stop a staged rollout", Glyph.STOP,
        ),
        "fleet.update_everything" to Action(
            "started updating everything", "tried to update everything", "tried to update everything", Glyph.SEND,
            doneAlone = "started updating everything",
        ),
        "fleet.rollback_last_good" to Action(
            "rolled back {} to last good firmware", "tried to roll back {} to last good firmware", "tried to roll back to last good firmware",
            Glyph.RESTART, doneAlone = "rolled back to last good firmware",
        ),
        // Scheduled starts (console 2.16.0).
        "schedule.create" to Action(
            "scheduled the start", "tried to schedule the start", "tried to schedule a start", Glyph.CLOCK,
            doneAlone = "scheduled a start",
        ),
        "schedule.edit" to Action(
            "changed the scheduled start", "tried to change the scheduled start", "tried to change a scheduled start", Glyph.CLOCK,
        ),
        "schedule.cancel" to Action(
            "cancelled the scheduled start", "tried to cancel the scheduled start", "tried to cancel a scheduled start", Glyph.STOP,
        ),
        "schedule.start" to Action(
            "carried out the scheduled start", "could not carry out the scheduled start", "could not carry out a scheduled start",
            Glyph.SEND, doneAlone = "carried out a scheduled start",
        ),
        "device.seen" to Action(
            "saw {} over Bluetooth", "tried to say a phone saw {}", "tried to say a phone saw a board", Glyph.CHIP,
            doneAlone = "saw a board over Bluetooth",
        ),
        "firmware.notes" to Action(
            "changed the note of", "tried to change the note of", "tried to change the note of a release", Glyph.FILE,
        ),
        // The console's Apps page: publishing the Android app, and a download of it.
        "app.upload" to Action(
            "started publishing the Android app", "tried to start publishing the Android app",
            "tried to start publishing the Android app", Glyph.UPLOAD,
        ),
        "app.publish" to Action(
            "published the Android app", "tried to publish the Android app", "tried to publish the Android app", Glyph.PACKAGE,
        ),
        "app.download" to Action(
            "downloaded the Android app", "tried to download the Android app", "tried to download the Android app", Glyph.DOWNLOAD,
        ),
        // The iPhone app's IPAs, the same three steps, and a member's SideStore link (docs/mobile-apps.md).
        "app.ios_upload" to Action(
            "started publishing the iPhone app", "tried to start publishing the iPhone app",
            "tried to start publishing the iPhone app", Glyph.UPLOAD,
        ),
        "app.ios_publish" to Action(
            "published the iPhone app", "tried to publish the iPhone app", "tried to publish the iPhone app", Glyph.PACKAGE,
        ),
        "app.ios_download" to Action(
            "downloaded the iPhone app", "tried to download the iPhone app", "tried to download the iPhone app", Glyph.DOWNLOAD,
        ),
        "app.source_create" to Action(
            "made SideStore link", "tried to make SideStore link", "tried to make a SideStore link", Glyph.KEY,
            doneAlone = "made a SideStore link",
        ),
        "app.source_revoke" to Action(
            "turned off SideStore link", "tried to turn off SideStore link", "tried to turn off a SideStore link", Glyph.KEY,
            doneAlone = "turned off a SideStore link",
        ),
        // The customer site's accounts, from the console's Customers page (docs/customer-site.md): a customer by
        // their e-mail address, and "a customer" after a board is that address where the entry has it.
        "customer.create" to Action("invited the customer", "tried to invite the customer", "tried to invite a customer", Glyph.USER),
        "customer.resend" to Action(
            "sent the invitation again to", "tried to send the invitation again to", "tried to send an invitation again", Glyph.SEND,
            doneAlone = "sent an invitation again",
        ),
        "customer.assign" to Action(
            "gave {} to a customer", "tried to give {} to a customer", "tried to give a board to a customer", Glyph.CHIP,
        ),
        "customer.unassign" to Action(
            "took {} back from a customer", "tried to take {} back from a customer", "tried to take a board back from a customer",
            Glyph.UNDO,
        ),
        // What a customer did on the customer site: "A customer" did it (actorOf).
        "customer_action.rename" to Action(
            "named {} on the customer site", "tried to name {} on the customer site",
            "tried to name a board on the customer site", Glyph.CHIP,
        ),
        "customer_action.notifications" to Action(
            "chose their e-mails on the customer site", "tried to choose their e-mails on the customer site",
            "tried to choose their e-mails on the customer site", Glyph.SEND,
        ),
        "customer.disable" to Action(
            "switched off the customer account of", "tried to switch off the customer account of",
            "tried to switch off a customer account", Glyph.BAN,
        ),
        "customer.enable" to Action(
            "switched on the customer account of", "tried to switch on the customer account of",
            "tried to switch on a customer account", Glyph.CHECK,
        ),
        // A customer's password reset and removal, and the team's accounts from the Team page (docs/accounts.md).
        "customer.reset_password" to Action(
            "reset the password of the customer", "tried to reset the password of the customer", "tried to reset a customer’s password", Glyph.KEY,
        ),
        "customer.remove" to Action(
            "removed the customer", "tried to remove the customer", "tried to remove a customer", Glyph.X,
        ),
        "account.invite" to Action(
            "invited", "tried to invite", "tried to invite a person to the team", Glyph.USER,
            doneAlone = "invited a person to the team",
        ),
        "account.resend" to Action(
            "sent the team invitation again to", "tried to send the team invitation again to", "tried to send a team invitation again", Glyph.SEND,
            doneAlone = "sent a team invitation again",
        ),
        "account.tier" to Action(
            "changed the tier of", "tried to change the tier of", "tried to change a tier", Glyph.SHIELD,
        ),
        "account.disable" to Action(
            "disabled the account of", "tried to disable the account of", "tried to disable an account", Glyph.BAN,
        ),
        "account.enable" to Action(
            "enabled the account of", "tried to enable the account of", "tried to enable an account", Glyph.CHECK,
        ),
        "account.reset" to Action(
            "reset the password and authenticator of", "tried to reset the password and authenticator of", "tried to reset an account", Glyph.KEY,
        ),
        "account.remove" to Action(
            "removed the account of", "tried to remove the account of", "tried to remove an account", Glyph.X,
        ),
        // A new board registered in AWS IoT through the console (docs/new-board-setup.md).
        "device.register" to Action(
            "registered", "tried to register", "tried to register a board", Glyph.CHIP,
            doneAlone = "registered a board",
        ),
        // Board setup's Wi-Fi defaults handed to a release manager (docs/new-board-setup.md).
        "setup.wifi_defaults" to Action(
            "read the Wi-Fi defaults", "tried to read the Wi-Fi defaults", "tried to read the Wi-Fi defaults", Glyph.LOCK,
        ),
        // An export of the console's Database page, by its table (docs/database.md).
        "db.export" to Action(
            "exported the {} table", "tried to export the {} table", "tried to export from the database", Glyph.DOWNLOAD,
            doneAlone = "exported from the database",
        ),
        // The weekly fleet report (docs/reports.md): a week as CSV, by its Monday, and its Monday e-mail.
        "report.export" to Action(
            "downloaded the weekly report of", "tried to download the weekly report of", "tried to download a weekly report", Glyph.DOWNLOAD,
            doneAlone = "downloaded a weekly report",
        ),
        "report.settings" to Action(
            "changed the Monday e-mail of the weekly report", "tried to change the Monday e-mail of the weekly report",
            "tried to change the Monday e-mail of the weekly report", Glyph.BELL,
            doneAlone = "changed the Monday e-mail of the weekly report",
        ),
    )

    /** The customer actions whose target is a board, and whose sentence ends with the customer. */
    private val CUSTOMER_BOARD = setOf("customer.assign", "customer.unassign")

    /** What the schedule that moves staged rollouts on did is the console's own: no person asked for it. */
    private val CONSOLE_ACTIONS = setOf("rollout.advance", "rollout.stop")

    val SIGNED_IN_ON = mapOf("web" to "signed in on the website", "phone" to "signed in on the phone app")

    /** What a command sent to a board asked of it, with the board where {} stands. */
    val COMMAND_WORDS = mapOf(
        "identify" to "asked {} to blink its lights",
        "report" to "asked {} to report now",
        "memfault" to "asked {} to send its Memfault data now",
    )

    /**
     * What a command at a board's serial console did, with the board where {} stands. What was
     * typed after the command is never recorded, so never said.
     */
    val SERIAL_WORDS = mapOf(
        "INIT" to "set up {} from factory mode over USB",
        "SET_ID" to "changed the device ID of {} over USB",
        "RESET_CONFIG" to "cleared the cloud settings of {} over USB",
        "FACTORY_RESET" to "erased {} back to factory mode over USB",
        "WIFI" to "set the Wi-Fi network of {} over USB",
        "WIFI_SEC" to "set the Wi-Fi network and its security mode of {} over USB",
        "CLEAR_WIFI" to "erased the Wi-Fi network of {} over USB",
        "CLOUD" to "set the AWS IoT endpoint and download address of {} over USB",
        "KEYGEN" to "made a new device key on {} over USB",
        "MQTT_HOST" to "set the AWS IoT endpoint of {} over USB",
        "MQTT_RECONNECT" to "reconnected {} to AWS IoT over USB",
        "BUTTON" to "pressed a button of {} over USB",
        "REBOOT" to "restarted {} over USB",
        "ENTER_BOOTLOADER" to "restarted {} into its bootloader over USB",
    )

    // What scripts/firmware/ota.sh without an API token, and the test bench, call their requests.
    private const val SCRIPTED_REQUEST = "bench-"

    const val SCRIPTED_TAG = "Script, no sign-in"
    const val SCRIPTED_NOTE = "Sent by a script (the test bench, or scripts/firmware/ota.sh without an API token) with AWS credentials, " +
        "directly to the API function. Nobody signed in. The name is the one the script gave, which has to be an active " +
        "release manager, so the entry does not show that this person did it."

    private val OUTCOMES = mapOf(
        "rejected" to StateWords(Tone.WARN, Glyph.BAN, "Refused"),
        "denied" to StateWords(Tone.BAD, Glyph.LOCK, "Not allowed"),
        "error" to StateWords(Tone.BAD, Glyph.ALERT, "Server error"),
    )

    /** Why the server refused a request or failed at it, in words, for a code. */
    val REFUSAL_WORDS = mapOf(
        "account_inactive" to "The account is not active",
        "already_cancelled" to "That deployment was already cancelled",
        "already_finished" to "That deployment had already finished",
        "already_revoked" to "That release was already revoked",
        "already_subscribed" to "Alerts already go to that address",
        "audit_failed" to "The change could not be written to this log",
        "bad_header" to "The image header cannot be read",
        "bad_signing_key" to "The server’s signing key cannot be read",
        "cancel_refused" to "AWS IoT would not cancel it",
        "forbidden" to "This account may not do that",
        "internal_error" to "Something went wrong on the server",
        "invalid_body" to "The request could not be read",
        "invalid_deployment" to "Not a valid deployment ID",
        "invalid_filename" to "The file name has characters the server does not accept, or is too long",
        "invalid_json" to "The request could not be read",
        "invalid_seconds" to "A board blinks for 1 to 60 seconds",
        "invalid_thing" to "Not a valid board name",
        "invalid_things" to "The list of boards is not valid",
        "invalid_version" to "Not a valid version number",
        "no_email" to "The account has no e-mail address",
        "not_confirmed" to "The subscription waits for its e-mail to be confirmed",
        "not_found" to "There is nothing at that address",
        "not_subscribed" to "Alerts do not go to that address",
        "payload_too_large" to "The request was too large",
        "release_manager_required" to "Only a release manager can do this",
        "revoke_incomplete" to "The revocation did not finish",
        "throttled" to "AWS asked the server to slow down",
        "timeout" to "The server ran out of time",
        "unauthorized" to "The sign-in was not accepted",
        "unknown_deployment" to "There is no such deployment",
        "unknown_device" to "A board is not registered",
        "unknown_version" to "There is no such release",
        "image_unavailable" to "The image could not be read; it may have been revoked",
        "image_mismatch" to "The stored image is not the one that was verified",
        "invalid_name" to "Not the name of a board over Bluetooth",
        "invalid_board" to "Not the name of a board over Bluetooth",
        "invalid_sha256" to "Not a valid SHA-256",
        "sha256_mismatch" to "The phone’s image is not the release’s",
        "no_pairing" to "No board online was pairing under that name",
        "unsupported_flags" to "Uses image options this project does not",
        "upload_conflict" to "Another upload was under way at that moment",
        "wrong_key" to "Signed with a different key than this project’s",
        "bad_signature" to "The signature is not valid",
        "unsigned" to "Not signed",
        "hash_mismatch" to "The file is damaged",
        "bad_magic" to "Not an MCUboot image",
        "not_an_image" to "Not an MCUboot image",
        "too_small" to "Too small to be a firmware image",
        "too_large" to "Too large for the board’s slot",
        "truncated" to "Shorter than its header says",
        "wrong_target" to "Not built for this product’s flash layout",
        "trailing_data" to "Has data after the signature",
        "unexpected_tlv" to "Not signed the way this project requires",
        "malformed_tlv" to "The signature area cannot be read",
        "bad_signature_encoding" to "The signature cannot be read",
        "version_exists" to "That version is already registered",
        "version_not_newer" to "Not newer than the highest version registered",
        "version_zero" to "Version 0.0.0+0 is never accepted",
        "device_busy" to "A board had an unfinished update",
        "release_revoked" to "The release is revoked",
        "not_uploaded" to "The file of that Pi image has not arrived",
        "no_pi" to "A board reports no Raspberry Pi",
        "invalid_token" to "The API token was not valid, or had been revoked or had expired",
        "token_not_allowed" to "An API token cannot be used for that",
        "phone_not_allowed" to "The phone app’s sign-in cannot be used for that",
        "phone_sign_in_again" to "A change from the phone needs a sign-in in the last 15 minutes",
        "too_many_tokens" to "That person already had as many API tokens as one may have",
        "invalid_token_name" to "The token’s name was empty, too long or not one line",
        "invalid_days" to "The token’s lifetime was not a whole number of days from 1 to 90",
        "invalid_token_id" to "Not a valid token ID",
        "unknown_token" to "That person has no API token with that ID",
        "token_already_revoked" to "That API token was already revoked",
        "invalid_time" to "A time was not written the way the server reads times",
        "invalid_range" to "The time range was empty, backwards or longer than 31 days",
        "invalid_kinds" to "The list of kinds of event was not valid",
        "invalid_hours" to "The number of hours was not a whole number from 1 to 168",
        "invalid_tags" to "The list of sources of the board log was not valid",
        "invalid_search" to "The search was empty, longer than 100 characters or not one line",
        "invalid_level" to "The level was neither info nor warn",
        "invalid_actions" to "The list of kinds of activity was not valid",
        "invalid_outcomes" to "The list of outcomes was not valid",
        "invalid_command" to "Not a command that changes a board at its serial console",
        "invalid_device" to "Not a board’s device ID",
        "unexpected_field" to "The request held more than the command, the device ID and the version",
        "rate_limited" to "More serial console commands in a minute than are recorded for one person",
        "incompatible_board" to "The release is for another type of board",
        "incompatible_layout" to "The release is built for another flash layout",
        "invalid_layout_tlv" to "The flash layout in the image was not a positive whole number",
        "invalid_layout" to "The flash layout was not a whole number from 1",
        "bluetooth_only" to "The board has no Wi-Fi and updates over Bluetooth from a phone",
        "invalid_type" to "Not a board type this console knows",
        "unknown_board" to "The image is for a board type this console does not know",
        "invalid_board_tlv" to "The board type in the image was not one short word",
        "invalid_notes" to "The note was not one line of up to 500 characters",
        "unknown_group" to "There is no such group",
        "invalid_group" to "Not the id of a group",
        "name_taken" to "Another group already has that name",
        "too_many_groups" to "There can be at most 50 groups",
        "group_changed" to "Someone changed the group at the same moment",
        "nothing_to_change" to "The request named nothing to change",
        "unknown_rollout" to "There is no such staged rollout",
        "invalid_rollout" to "Not the id of a staged rollout",
        "invalid_target" to "Not a target of a rollout: boards, a group, a type or the fleet",
        "invalid_types" to "The list of board types and their releases was not valid",
        "invalid_canary" to "The canary was not a whole number from 1 to 5",
        "invalid_wave" to "The first wave was not a whole number from 1 to 50 boards",
        "invalid_abortPercent" to "The share of failures to stop at was not a whole number from 1 to 100",
        "invalid_stages" to "The number of stages was not a whole number from 1 to 10",
        "invalid_batch" to "The batch sizes were not a percent or a count for each stage but the last",
        "invalid_soakMinutes" to "The soak time was not a whole number of minutes from 0 to 60",
        "nothing_to_deploy" to "No board would take the release",
        "too_many_boards" to "A rollout takes at most 100 boards",
        "plan_changed" to "The plan had changed since it was shown",
        "no_older_release" to "There is no older release of that type to go back to",
        "gate_required" to "A roll back to last good runs with the health gate on",
        "invalid_targets" to "The releases asked for were not a list of versions, each with its boards",
        "rollout_changed" to "The rollout moved on while it was being cancelled",
        "rollout_unrecorded" to "The rollout could not be recorded, so its canary was withdrawn",
        "partly_started" to "Only some of the rollouts could be started",
        "invalid_healthGate" to "The health gate was not on or off with 0 to 120 minutes",
        "invalid_kind" to "Not something that can be scheduled: a deployment, a staged rollout or a roll back to last good",
        "invalid_at" to "The time was not a local date and time",
        "invalid_timeZone" to "Not a time zone",
        "invalid_request" to "What to start was not given",
        "invalid_schedule" to "Not the id of a scheduled start",
        "unknown_schedule" to "There is no such scheduled start",
        "schedule_in_past" to "The time was less than a minute from now, or past",
        "schedule_too_far" to "The time was more than 30 days ahead",
        "schedule_over" to "The scheduled start has begun, ended or was cancelled",
        "schedule_changed" to "Someone changed the scheduled start at the same moment",
        "too_many_schedules" to "There can be at most 50 scheduled starts",
        "invalid_window" to "The maintenance window was not days, a start and an end, and a time zone",
        "creator_not_allowed" to "Whoever scheduled it is no longer an enabled release manager, so it did not start",
        // The alert rules (cloud/api/src/handlers/alerts.mjs).
        "invalid_rules" to "The alert rules asked for were not rules, or not within their limits",
        "rules_changed" to "Someone changed the alert rules at the same moment",
        // The phone apps (the API's handlers/apps.mjs): publishing the Android app, and its download links.
        "version_code_not_higher" to "Its versionCode is not higher than the newest Android app’s",
        "apk_missing" to "No APK had arrived in S3 for that version",
        "ipa_missing" to "No IPA had arrived in S3 for that version",
        "ipa_unreadable" to "The IPA that arrived could not be read as an iPhone app",
        "ipa_mismatch" to "The IPA was not the app, the version, the build or the configuration it was published as",
        "build_not_higher" to "Its build is not higher than the newest iPhone app’s",
        "invalid_build" to "The build was not a whole number",
        "unknown_source" to "There was no SideStore link at that address",
        "no_source" to "There was no SideStore link to turn off",
        "source_conflict" to "The SideStore link was being changed at the same moment",
        "size_mismatch" to "The APK that arrived was of another size",
        "checksum_missing" to "The APK that arrived had no SHA-256 of its own",
        "publish_conflict" to "Another release of the app was being published at the same moment",
        "invalid_via" to "Not a way to hand out a link: a QR code, or none",
        "invalid_version_code" to "The versionCode was not a whole number",
        "invalid_size" to "The size was not a whole number of bytes, up to 100 MB",
        "unversioned" to "The bucket kept no version of the APK",
        // The customer site's customers (the API's handlers/customers.mjs) and its own API.
        "customers_not_set_up" to "This deployment has no customer pool",
        "customer_site_has_no_address" to "The customer site has no address yet, so an invitation would lead nowhere",
        "invalid_customer" to "Not a valid customer ID",
        "invalid_email" to "Not an e-mail address",
        "unknown_customer" to "There is no customer with that ID",
        "customer_exists" to "There is a customer with that address already",
        "customer_not_invited" to "That customer has signed in already, so there was no invitation to send again",
        "customer_not_signed_in" to "That customer had not chosen a password yet, so there was none to reset",
        "customer_disabled" to "That customer was switched off",
        "invalid_account" to "Not a valid account ID",
        "invalid_tier" to "Not a tier: viewer or release manager",
        "unknown_account" to "There is no account with that ID",
        "account_exists" to "There is an account with that address already",
        "account_not_invited" to "That person has signed in already, so there was no invitation to send again",
        "account_not_signed_in" to "That person had not signed in yet, so there was nothing to reset",
        "account_disabled" to "That account was disabled",
        "account_has_no_tier" to "That account had no tier",
        "own_account" to "Nobody can demote, disable, reset or remove their own account",
        "last_release_manager" to "It would have left no enabled release manager",
        "already_assigned" to "That board was that customer’s already",
        "board_taken" to "That board belongs to another customer",
        "not_assigned" to "That board was not that customer’s",
        "not_your_board" to "That customer has no such board",
        "invalid_label" to "Not a name a board can have",
        "label_too_long" to "A board’s name is at most 40 characters",
        "unknown_field" to "The request had a field that cannot be changed there",
        "invalid_choice" to "An e-mail can only be turned on or off",
        "nothing_chosen" to "No e-mail was turned on or off",
        "too_many_changes" to "Too many changes in a short time",
        "unavailable" to "The account could not be checked just then",
        "invalid_id" to "Not a board’s identifier of 16 hex digits",
        "invalid_csr" to "Not a certificate signing request a board makes",
        "csr_mismatch" to "The signing request is for another board",
        "already_registered" to "That board has a certificate already",
        "board_mismatch" to "That board is registered as another type",
        "certificate_mismatch" to "AWS IoT issued a certificate for another key",
        // Board setup's Wi-Fi defaults (docs/new-board-setup.md).
        "wifi_defaults_unavailable" to "The console could not read its Wi-Fi defaults just then",
        "wifi_defaults_invalid" to "The stored Wi-Fi defaults break the firmware’s rules",
        // The console's Database page (docs/database.md).
        "unknown_table" to "There is no such table",
        "invalid_filter" to "A filter of the Database page was not valid",
        "invalid_key" to "An item’s key was empty, too long or not plain text",
        "invalid_format" to "An export is CSV or JSON",
        // The weekly fleet report (docs/reports.md).
        "invalid_week" to "Not a week: a week is named by its Monday",
        "unknown_week" to "There is no report of that week",
        "invalid_report_format" to "A weekly report is downloaded as CSV",
        "invalid_report_settings" to "The Monday e-mail is on or off, and nothing else",
        "report_settings_changed" to "Someone changed the Monday e-mail at the same moment",
        "unknown_item" to "There is no item with that key",
    )

    private val REVOCATION_STEPS = mapOf(
        "tag" to "refusing the image",
        "cancel" to "cancelling the deployments",
        "record" to "recording that it is done",
    )

    /** The board types (core.js BOARD_LABELS). */
    val BOARD_LABELS = mapOf("nrf7002dk" to "nRF7002 DK", "nrf5340dk" to "nRF5340 DK")

    private data class Detail(
        val label: String,
        val code: Boolean = false,
        val sentence: Boolean = false,
        val say: ((String) -> String)? = null,
    )

    private val WHOLE = Regex("^\\d+$")

    // In the order in which a line reads best (core.js AUDIT_DETAILS).
    private val DETAILS: LinkedHashMap<String, Detail> = linkedMapOf(
        "code" to Detail("Refused with", code = true),
        "incomplete" to Detail("Left undone", sentence = true, say = { value ->
            value.split(' ').filter { it.isNotEmpty() }.joinToString(", ") { REVOCATION_STEPS[it] ?: it }
        }),
        "filename" to Detail("File", code = true),
        "version" to Detail("Version", code = true),
        "things" to Detail("Boards"),
        "force" to Detail("Asked to", say = { value ->
            when (value) {
                "true" -> "withdraw the offer and stop boards that had started"
                "false" -> "withdraw the offer"
                else -> value
            }
        }),
        "reason" to Detail("Reason", sentence = true),
        "cancelled" to Detail("Cancelled", say = { value ->
            when (value) {
                "true" -> "all the same"
                "false" -> "no"
                else -> value
            }
        }),
        "size" to Detail("Size", say = { value -> value.toLongOrNull()?.let { Words.exactBytes(it) }?.takeIf { it.isNotEmpty() } ?: value }),
        "sha256" to Detail("SHA-256", code = true),
        "token" to Detail("With API token", code = true),
        "tokenState" to Detail("The token had", say = { value -> if (value == "revoked") "been revoked" else value }),
        "board" to Detail("To board", code = true),
        "thing" to Detail("Board", code = true),
        "boards" to Detail("To"),
        "command" to Detail("Command", code = true),
        "from" to Detail("From", say = { value -> if (value == "phone") "the phone app" else value }),
        "client" to Detail("On", say = { value -> mapOf("web" to "the website", "phone" to "the phone app")[value] ?: value }),
        "name" to Detail("Named", sentence = true),
        "cmd" to Detail("Command", code = true),
        "seconds" to Detail("For", say = { value -> if (WHOLE.matches(value)) "$value s" else value }),
        "id" to Detail("Command id", code = true),
        "subscription" to Detail("Now", say = { value -> if (value == "pending") "waiting for the address to confirm" else value }),
        "days" to Detail("Valid for", say = { value -> if (WHOLE.matches(value)) Words.plural(value.toLong(), "day") else value }),
        "withdrawn" to Detail("Withdrawn", say = { value -> if (value == "true") "at once, to stay within the limit" else value }),
        "kind" to Detail("To", say = { value ->
            mapOf("boards" to "boards named one by one", "group" to "a group", "type" to "a board type", "fleet" to "the whole fleet")[value]
                ?: value
        }),
        "canary" to Detail("Canary", code = true),
        "stages" to Detail("Stages"),
        "stage" to Detail("Stage"),
        "rollouts" to Detail("Rollouts", code = true),
        "versions" to Detail("Releases"),
        "group" to Detail("Group"),
        "job" to Detail("Deployment", code = true),
        "renamedFrom" to Detail("Was called", sentence = true),
        "added" to Detail("Boards added"),
        "removed" to Detail("Boards removed"),
        "notes" to Detail("New note", sentence = true),
        "oldLength" to Detail("Old note", say = { value -> if (value == "0") "none" else "$value characters" }),
        "type" to Detail("Board type", say = { value -> BOARD_LABELS[value] ?: value }),
        // A customer of the customer site: their address, their account id, and what a board was called for them.
        "email" to Detail("E-mail"),
        "customer" to Detail("Customer", code = true),
        "label" to Detail("Called", sentence = true),
    )

    private fun fact(entry: AuditEntry, key: String, value: String): AuditFact {
        val known = DETAILS[key] ?: return AuditFact(key, key, value, code = false, phrase = false)
        var label = known.label
        // A revocation counts the deployments it cancelled; a failure that is not a refusal did not refuse anything.
        if (key == "cancelled" && entry.action == "firmware.revoke") label = "Deployments cancelled"
        if (key == "code" && entry.outcome == "error") label = "Failed with"
        // The firmware a board ran when a command was given at its serial console.
        if (key == "version" && entry.action == "serial.command") label = "Running"
        return AuditFact(
            key = key,
            label = label,
            value = known.say?.invoke(value) ?: value,
            code = known.code,
            phrase = !known.sentence,
            words = if (key == "code") REFUSAL_WORDS[value] else null,
        )
    }

    private val BOARD_COUNT = Regex("^[1-9]\\d{0,3}$")

    /** One line of the activity log. A deployment is called by its version; its id goes to the facts. */
    fun describe(entry: AuditEntry): AuditWords {
        val action = ACTIONS[entry.action]
        val ok = entry.outcome == "ok"
        val deployment = entry.target.takeIf { ApiJson.isDeploymentId(it) }
        val details = entry.detail.toMap()
        // A customer is told by their address, where the entry has it, not by the id of their account.
        // And a person of the team by theirs (account.*).
        val customerEmail =
            if (entry.action.startsWith("customer.") || entry.action.startsWith("account.")) details["email"].orEmpty() else ""
        val byAddress = customerEmail.isNotEmpty() && entry.action !in CUSTOMER_BOARD
        val label = when {
            deployment != null -> Updates.versionOfDeployment(deployment) ?: deployment
            byAddress -> customerEmail
            else -> entry.target
        }
        // A revocation that completed what an earlier request had begun.
        val resumed = entry.action == "firmware.revoke" && ok && details["resumed"] == "true"
        val words = when {
            resumed -> "finished revoking firmware"
            entry.action == "account.sign_in" && ok && action != null -> SIGNED_IN_ON[details["client"]] ?: action.done
            entry.action == "serial.command" && ok && action != null -> SERIAL_WORDS[details["command"]] ?: action.done
            entry.action == "board.command" && ok && action != null -> COMMAND_WORDS[details["cmd"]] ?: action.done
            action != null && ok -> if (label.isNotEmpty()) action.done else action.doneAlone ?: action.done
            action != null -> if (label.isNotEmpty()) action.tried else action.triedAlone
            else -> entry.action.ifEmpty { "did something" }
        }

        var verb = words
        var tail = ""
        val slot = words.indexOf("{}")
        if (slot >= 0 && label.isNotEmpty()) {
            verb = words.substring(0, slot).trimEnd()
            tail = words.substring(slot + 2).trimStart()
        } else if (slot >= 0) {
            verb = words.replace("{}", "a board")
        }
        if (label.isEmpty()) verb = verb.removeSuffix(" of")
        // "gave CRVIHAAN01 to <the customer's address>": the board, then whose it is now.
        if (entry.action in CUSTOMER_BOARD && customerEmail.isNotEmpty()) tail = tail.replace(Regex("a customer$"), customerEmail)

        // The boards of a deployment: by name where the entry has them, else how many.
        val creates = entry.action == "deployment.create"
        val boards = if (creates) details["boards"].orEmpty().split(' ').filter { ApiJson.isThing(it) } else emptyList()
        val counted = if (creates) details["things"]?.takeIf { BOARD_COUNT.matches(it) }?.toInt() ?: 0 else 0
        val boardCount = maxOf(counted, boards.size)

        // What the sentence says already is not said again as a fact.
        val said = buildSet {
            if (entry.action == "account.sign_in") add("client")
            if (customerEmail.isNotEmpty() && (byAddress || label.isNotEmpty())) add("email")
            if (creates && boardCount > 0) add("things")
            if (boards.size <= 2) add("boards")
        }
        val order = LinkedHashSet<String>().apply {
            addAll(DETAILS.keys)
            addAll(entry.detail.map { it.first })
        }
        val facts = mutableListOf<AuditFact>()
        for (key in order) {
            val value = details[key] ?: continue
            if (key in said) continue
            if (key == "version" && value == label) continue
            if (key == "resumed" && resumed) continue
            if (key == "filename" && value == label) continue
            facts += fact(entry, key, value)
        }
        if (deployment != null) facts += AuditFact("target", "Deployment", deployment, code = true, phrase = true)
        val link = when {
            deployment != null -> LogLink.ToDeployment(deployment)
            FirmwareVersion.parseStrict(entry.target) != null -> LogLink.ToFirmware
            else -> null
        }
        return AuditWords(
            glyph = action?.glyph ?: Glyph.LIST,
            verb = verb,
            label = label,
            tail = tail,
            outcome = if (ok) null else OUTCOMES[entry.outcome] ?: StateWords(Tone.IDLE, Glyph.MINUS, entry.outcome.ifEmpty { "Unknown" }),
            link = link,
            facts = facts,
            scripted = entry.requestId.startsWith(SCRIPTED_REQUEST),
            boards = boards,
            boardCount = boardCount,
            byName = entry.action == "serial.command" && Boards.isBoardName(label),
        )
    }

    /** Who did what an entry says: a person, or for what the schedule did, the console. */
    fun actorOf(entry: AuditEntry): String = when {
        // Only the customer API writes these, and never with the customer's address.
        entry.action.startsWith("customer_action.") -> "A customer"
        entry.action in CONSOLE_ACTIONS && entry.actor?.sub.isNullOrEmpty() -> "The console"
        else -> Words.nameOf(entry.actor)
    }

    /**
     * Where a deployment went, each board by what it is called in [devices]: "to CRVIHAAN01",
     * "to CRVIHAAN01 and cranium-0123…", "to 3 boards"; "" when the entry does not say.
     */
    fun boards(words: AuditWords, devices: List<Device>? = null): String = when {
        words.boards.isNotEmpty() && words.boards.size <= 2 ->
            "to " + words.boards.joinToString(" and ") { Boards.name(Boards.of(it, devices)) }
        words.boardCount > 0 -> "to ${Words.plural(words.boardCount, "board")}"
        else -> ""
    }

    /** A whole line in words, for where it is plain text: "a@b deployed 1.12.0+0 to CRVIHAAN01". */
    fun sentence(entry: AuditEntry, devices: List<Device>? = null): String {
        val words = describe(entry)
        return listOf(actorOf(entry), words.verb, words.label, words.tail, boards(words, devices))
            .filter { it.isNotEmpty() }.joinToString(" ")
    }

    /**
     * A line of the log as a page shows it (views.js activityLine): an entry of a deployment from
     * before the log named its boards says where it went as the deployment, [run], does now.
     */
    fun line(entry: AuditEntry, devices: List<Device>?, run: DeploymentSummary?): String {
        var words = describe(entry)
        if (words.boards.isEmpty() && run != null && entry.action == "deployment.create" && entry.outcome == "ok") {
            val things = run.things.filter { ApiJson.isThing(it) }
            words = words.copy(boards = things, boardCount = maxOf(words.boardCount, things.size))
        }
        return listOf(actorOf(entry), words.verb, words.label, words.tail, boards(words, devices))
            .filter { it.isNotEmpty() }.joinToString(" ")
    }

    /** The sentence with how it ended when not well: the Console lane, and a screen reader. */
    fun spoken(entry: AuditEntry, devices: List<Device>? = null): String {
        val what = sentence(entry, devices)
        val outcome = describe(entry).outcome
        return if (outcome != null) "$what (${outcome.label.lowercase()})" else what
    }
}

/** What the server checks before it stores an image, in the order it does so (core.js IMAGE_CHECKS). */
object ImageChecks {
    data class Check(val name: String, val passed: String, val passedFirst: String? = null, val codes: List<String>)

    val ALL = listOf(
        Check(
            "Image format", "It is an MCUboot image, and it fits the board’s update slot.",
            codes = listOf("not_an_image", "too_small", "too_large", "bad_magic", "bad_header", "truncated"),
        ),
        Check("Flash layout", "It was built for this product’s flash layout.", codes = listOf("unsupported_flags", "wrong_target")),
        Check(
            "Signature area", "Its signature area is well formed, with nothing after it.",
            codes = listOf("malformed_tlv", "unexpected_tlv", "trailing_data", "unsigned"),
        ),
        Check("Image hash", "The image matches its own SHA-256 hash, so the file is not damaged.", codes = listOf("hash_mismatch")),
        Check("Signing key", "It is signed with this project’s key.", codes = listOf("wrong_key")),
        Check("Signature", "Its ECDSA P-256 signature is valid.", codes = listOf("bad_signature", "bad_signature_encoding")),
        Check(
            "Version", "Its version is newer than every release before it.",
            passedFirst = "Its version has a number, and no release came before it.",
            codes = listOf("version_zero", "version_exists", "version_not_newer"),
        ),
    )

    /** The name of the check an image failed, from the code of the server's refusal. */
    fun failedCheck(code: String?): String? = ALL.firstOrNull { code in it.codes }?.name

    private const val SIGNED_WRONGLY = "This image is not signed the way this project requires: an ECDSA P-256 signature, " +
        "with a hash of the public key. Sign it with the project’s imgtool settings."

    private val PLAIN_WORDS = mapOf(
        "unexpected_tlv" to SIGNED_WRONGLY,
        "malformed_tlv" to "The signature area of this image cannot be read. Build and sign it again.",
        "bad_signature_encoding" to "The signature in this image cannot be read. Build and sign it again.",
    )

    /** What to say about a failed request: the server's wording, unless it is written in jargon. */
    fun plainMessage(error: ApiError): String = PLAIN_WORDS[error.code] ?: (error.message ?: "")
}

/** What a failed request means for what happens next (core.js). */
object Outcomes {
    /** A refusal: the server understood the request and said no, so nothing was changed. */
    fun isRefusal(status: Int): Boolean = status in 400..499

    /** Whether the page has to be read again after a change failed. */
    fun staleAfter(error: Throwable): Boolean {
        val status = (error as? ApiError)?.status ?: return true
        return !isRefusal(status) || status == 409
    }

    /** Whether sending the same file once more could end differently. */
    fun canRetryUpload(error: Throwable): Boolean {
        val api = error as? ApiError ?: return true
        return !isRefusal(api.status) || api.status == 429 || api.code == "upload_conflict"
    }
}

/** What can be said about a chosen file before it is uploaded (core.js reviewImage). */
object UploadReview {
    enum class NoteTone { GOOD, WARN, BAD, WAIT }

    data class Note(val tone: NoteTone, val text: String)

    data class Review(val blocked: Boolean, val doomed: Boolean, val notes: List<Note>)

    /** The header of a chosen file, as far as the phone reads it: a preview, so that a wrong file shows early. */
    data class Header(val ok: Boolean, val message: String = "", val headerSize: Int = 0, val payloadSize: Long = 0, val version: String = "")

    fun readHeader(data: ByteArray): Header {
        if (data.size < McubootHeader.LENGTH) return Header(false, "The file is too small to be a firmware image.")
        val header = McubootHeader.parse(data)
            ?: return Header(false, "This is not an MCUboot image. Choose the *.signed.bin file from the build.")
        return Header(true, headerSize = header.headerSize, payloadSize = header.imageSize, version = header.version.toString())
    }

    const val SIGNATURE_UNCHECKED = "Signature: not checked yet. The server checks it against the project key when you upload."

    fun review(header: Header, size: Long, digest: String, firmware: ReleaseList?): Review {
        val notes = mutableListOf<Note>()
        if (!header.ok) return Review(blocked = true, doomed = false, notes = listOf(Note(NoteTone.BAD, header.message)))
        val slot = firmware?.slotSize
        var blocked = false
        if (slot != null && size > slot) {
            blocked = true
            notes += Note(NoteTone.BAD, "Too large: the board’s slot holds ${Words.exactBytes(slot)}.")
        } else if (slot != null) {
            notes += Note(NoteTone.GOOD, "Fits the board’s ${Words.fileSize(slot)} slot.")
        }
        if (header.version == "0.0.0+0") {
            notes += Note(NoteTone.WARN, "Version 0.0.0+0 is never accepted. Give the build a version first.")
            return Review(blocked, true, notes)
        }
        if (firmware == null) return Review(blocked, false, notes)
        val version = FirmwareVersion.parseStrict(header.version)
        val same = firmware.releases.firstOrNull { it.sha256 == digest }
        val taken = firmware.releases.firstOrNull { it.version == header.version }
        val highest = firmware.releases.mapNotNull { FirmwareVersion.parseStrict(it.version) }.maxOrNull()
        val notNewer = highest != null && version != null && version <= highest
        val doomed = same != null || taken != null || notNewer
        when {
            same != null -> notes += Note(NoteTone.WARN, "This exact file is already registered as ${same.version}.")
            taken != null -> notes += Note(
                NoteTone.WARN, "${taken.version} is already registered with different contents. A version can be used once.",
            )
            notNewer -> notes += Note(
                NoteTone.WARN, "Not newer than $highest, the highest version registered so far. The server will refuse it.",
            )
            highest != null -> notes += Note(NoteTone.GOOD, "Newer than every registered release (highest so far: $highest).")
            else -> notes += Note(NoteTone.GOOD, "This will be the first release.")
        }
        return Review(blocked, doomed, notes)
    }
}
