package com.craniumiot.cranium.update

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.security.MessageDigest

/**
 * The FileProvider of the updates alone (AndroidManifest.xml, authority `<applicationId>.updates`,
 * res/xml/update_paths.xml): it serves the files under cacheDir/updates and nothing else. A class
 * of its own, so that it never merges with a FileProvider a library declares.
 */
class UpdateFileProvider : FileProvider()

/** Handing a checked APK to Android's installer. */
object ApkInstaller {
    const val APK_TYPE = "application/vnd.android.package-archive"

    /** Where APKs are kept while they are checked and installed. The provider serves this folder only. */
    fun dir(context: Context): File = File(context.cacheDir, "updates")

    private fun authority(context: Context): String = "${context.packageName}.updates"

    /** Whether the person has let this app install apps ("Install unknown apps"). Android asks once. */
    fun mayInstall(context: Context): Boolean = context.packageManager.canRequestPackageInstalls()

    /** The Settings page where the person allows installs from this app. */
    fun allowInstalls(context: Context): Intent =
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** Android's installer, reading [apk] through the provider: only it is granted the file, and only to read. */
    fun install(context: Context, apk: File): Intent {
        val uri = FileProvider.getUriForFile(context, authority(context), apk)
        return Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, APK_TYPE)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    /**
     * What Android itself reads from [apk], before its installer is asked: that it is this app, with
     * the versionCode the console gave, signed with the key the installed app is signed with (an
     * update over another key is refused). Null if it is so, else why not. A signer Android does
     * not say is not held against it: the installer checks that again in any case.
     */
    fun mismatch(context: Context, apk: File, release: AppRelease): String? {
        val pm = context.packageManager
        val archive = archiveInfo(pm, apk) ?: return "Android cannot read the download of ${release.version} as an app. It was deleted."
        if (archive.packageName != context.packageName) return "The download of ${release.version} is not Cranium. It was deleted."
        @Suppress("DEPRECATION")
        val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) archive.longVersionCode else archive.versionCode.toLong()
        if (code != release.versionCode.toLong()) {
            return "The download of ${release.version} is not the version the console described. It was deleted."
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val theirs = signers(archive)
            val ours = runCatching { signers(pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)) }.getOrNull()
            if (!theirs.isNullOrEmpty() && !ours.isNullOrEmpty() && theirs.intersect(ours).isEmpty()) {
                return "${release.version} is signed with another key than the Cranium on this phone (a build made on a computer?), " +
                    "so Android cannot install it over this one. Uninstall Cranium first, then install ${release.version}."
            }
        }
        return null
    }

    private fun archiveInfo(pm: PackageManager, apk: File): PackageInfo? {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES else 0
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.getPackageArchiveInfo(apk.path, PackageManager.PackageInfoFlags.of(flags.toLong()))
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageArchiveInfo(apk.path, flags)
        }
    }

    /** The SHA-256 of each certificate the package is (or was, by rotation) signed with. */
    private fun signers(info: PackageInfo): Set<String>? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return null
        val signing = info.signingInfo ?: return null
        val certificates = if (signing.hasMultipleSigners()) signing.apkContentsSigners else signing.signingCertificateHistory
        return certificates?.map { Sha256.hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }?.toSet()
    }
}
