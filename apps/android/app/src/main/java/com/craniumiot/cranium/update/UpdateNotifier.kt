package com.craniumiot.cranium.update

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import com.craniumiot.cranium.MainActivity
import com.craniumiot.cranium.R

/**
 * What the updater remembers on this phone, in plain SharedPreferences: nothing in it is secret.
 * The last versionCode a notification was posted for, so that none is posted twice for the same
 * version, and whether the app has asked for notifications already, so that it asks only once.
 */
class UpdatePrefs(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    var lastNotifiedCode: Int
        get() = prefs.getInt(KEY_NOTIFIED, 0)
        set(value) = prefs.edit(commit = true) { putInt(KEY_NOTIFIED, value) }

    var askedForNotifications: Boolean
        get() = prefs.getBoolean(KEY_ASKED, false)
        set(value) = prefs.edit(commit = true) { putBoolean(KEY_ASKED, value) }

    private companion object {
        const val FILE = "cranium_updates"
        const val KEY_NOTIFIED = "last_notified_version_code"
        const val KEY_ASKED = "asked_for_notifications"
    }
}

/** The system notification "Update available", on its own channel, "App updates". */
object UpdateNotifier {
    const val CHANNEL = "app_updates"
    private const val NOTIFICATION_ID = 0x0A99

    /** Android 13 and later ask the person for notifications (POST_NOTIFICATIONS); before, they are on unless turned off. */
    fun hasPermission(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** Whether the app may still ask: Android 13 or later, not allowed yet, and never asked on this phone. */
    fun mayAsk(context: Context, prefs: UpdatePrefs): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !hasPermission(context) && !prefs.askedForNotifications

    /**
     * Post "Update available" for [release] unless one was posted for its versionCode already, or
     * notifications are not allowed; then remember it. True if it was posted. Never asks for anything.
     */
    fun notifyOnce(context: Context, prefs: UpdatePrefs, release: AppRelease): Boolean {
        val app = context.applicationContext
        if (!AppUpdates.shouldNotify(release, prefs.lastNotifiedCode)) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(app, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        val manager = NotificationManagerCompat.from(app)
        if (!manager.areNotificationsEnabled()) return false
        ensureChannel(app)
        val open = app.packageManager.getLaunchIntentForPackage(app.packageName)
            ?: Intent(app, MainActivity::class.java)
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        val tap = PendingIntent.getActivity(app, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val text = release.notes.ifEmpty { "Open Cranium to install it." }
        val notification = NotificationCompat.Builder(app, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_update)
            .setContentTitle(AppUpdates.title(release))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        try {
            manager.notify(NOTIFICATION_ID, notification)
        } catch (e: SecurityException) {
            // Taken back between the check and the post: the banner in the app still says it.
            return false
        }
        prefs.lastNotifiedCode = release.versionCode
        return true
    }

    /** The newer version was installed, or none is offered: its notification goes. */
    fun clear(context: Context) {
        NotificationManagerCompat.from(context.applicationContext).cancel(NOTIFICATION_ID)
    }

    private fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL) != null) return
        val channel = NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "A new version of Cranium is on the console."
        }
        manager.createNotificationChannel(channel)
    }
}
