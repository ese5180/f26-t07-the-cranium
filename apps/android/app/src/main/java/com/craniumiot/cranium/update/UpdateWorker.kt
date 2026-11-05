package com.craniumiot.cranium.update

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.craniumiot.cranium.BuildConfig
import com.craniumiot.cranium.CraniumConfig
import com.craniumiot.cranium.api.AccessTokens
import com.craniumiot.cranium.auth.SignedOutException
import com.craniumiot.cranium.auth.TokenStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/**
 * The check once a day in the background: WorkManager's unique periodic work [NAME], only with a
 * network. If the console has a newer version, it posts "Update available" once for it
 * ([UpdateNotifier.notifyOnce]); the banner is the app's, when it next opens.
 *
 * The worker never asks the person anything: no sign-in, no fingerprint, no permission. It needs
 * an access token, and it takes only one that is there without the person (AuthManager, TokenStore):
 *
 *  - Fingerprint unlock on: the refresh token is kept only sealed with the fingerprint's key, and
 *    no session is kept in the clear. There is no token without the person, so the worker does
 *    nothing.
 *  - Off: the session TokenStore keeps, if its access token is good for at least another minute.
 *    The worker does not refresh it. The refresh token belongs to the app's AuthManager, which
 *    saves what it renews; a refresh here could cross one of the app's, and one Cognito refused
 *    would end the sign-in from the background. Without fingerprint unlock a session lasts an
 *    hour after the sign-in and then as long as its access token, so this finds a token mostly
 *    on the day of a sign-in.
 *  - Signed out: nothing.
 *
 * Whatever happens, no token, no network, a refusal, an answer it cannot read, it returns success
 * and changes nothing of the sign-in: the check when the app next opens covers it, and the next
 * day's run tries again. Nothing is logged.
 */
class UpdateWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val app = applicationContext
        val token = withContext(Dispatchers.IO) { runCatching { tokenWithoutThePerson(app) }.getOrNull() } ?: return Result.success()
        val releases = try {
            UpdateApi(CraniumConfig.fromBuild().consoleUrl, Kept(token)).releases()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return Result.success()
        }
        val found = AppUpdates.available(releases, BuildConfig.VERSION_CODE) ?: return Result.success()
        withContext(Dispatchers.IO) { UpdateNotifier.notifyOnce(app, UpdatePrefs(app), found) }
        return Result.success()
    }

    /** A token that is only used as it is: renewing it is the app's business, never the worker's. */
    private class Kept(private val token: String) : AccessTokens {
        override suspend fun accessToken(forceRefresh: Boolean): String =
            if (forceRefresh) throw SignedOutException("The app renews its own sign-in.") else token

        override suspend fun forget() = Unit
    }

    companion object {
        const val NAME = "cranium-app-update-check"
        private const val GOOD_FOR_AT_LEAST_S = 60L

        /** Once a day, with a network. KEEP: scheduling it again on every start leaves the one there as it is. */
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<UpdateWorker>(1, TimeUnit.DAYS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        /** The session's access token if it is there without the person and still good; else null. Only reads. */
        private fun tokenWithoutThePerson(context: Context): String? {
            val store = TokenStore(context)
            if (store.fingerprintOn()) return null
            val session = store.load() ?: return null
            val now = System.currentTimeMillis() / 1000
            if (session.accessToken.isEmpty() || session.expiresAt - now < GOOD_FOR_AT_LEAST_S) return null
            return session.accessToken
        }
    }
}
