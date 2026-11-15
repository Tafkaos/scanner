package io.github.tafkaos.scanner

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * Lädt alle wartenden PDFs nach Dropbox hoch. Läuft im Hintergrund, sobald Internet da ist,
 * und versucht es bei Netzproblemen später automatisch erneut.
 */
class UploadWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val store = Store(applicationContext)
        if (!store.connected) {
            store.setLastError("Dropbox ist nicht verbunden – Scans warten in der App.")
            return@withContext Result.success()
        }
        val time = SimpleDateFormat("dd.MM. HH:mm", Locale.GERMANY)
        // Mehrere Durchläufe, falls während des Uploads neue Scans dazukommen.
        repeat(5) {
            val files = store.pending()
            if (files.isEmpty()) {
                store.setLastError(null)
                return@withContext Result.success()
            }
            for (f in files) {
                val path = Dropbox.buildPath(store.folder, f.name)
                try {
                    val res = try {
                        Dropbox.upload(store.accessToken(), path, f)
                    } catch (e: DropboxException) {
                        if (e.status != 401) throw e
                        Dropbox.upload(store.accessToken(force = true), path, f)
                    }
                    f.delete()
                    val shown = res.optString("path_display", path)
                    store.addHistory("✔ ${time.format(Date())}  $shown")
                } catch (e: DropboxException) {
                    if (e.status == 400 && e.body.contains("invalid_grant")) {
                        store.setLastError("Dropbox-Freigabe ungültig. Bitte in der App neu verbinden.")
                        return@withContext Result.success()
                    }
                    if (e.status == 429 || e.status >= 500) {
                        store.setLastError("Dropbox ausgelastet, neuer Versuch folgt automatisch.")
                        return@withContext Result.retry()
                    }
                    store.setLastError("Upload von ${f.name} fehlgeschlagen: ${e.message}")
                    store.addHistory("✖ ${time.format(Date())}  ${f.name}: Fehler ${e.status}")
                    return@withContext Result.failure()
                } catch (e: IOException) {
                    store.setLastError("Keine Verbindung – Upload wird automatisch wiederholt.")
                    return@withContext Result.retry()
                }
            }
        }
        Result.success()
    }

    companion object {
        private const val NAME = "dropbox-upload"

        fun enqueue(context: Context) {
            val req = OneTimeWorkRequestBuilder<UploadWorker>()
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context)
                .enqueueUniqueWork(NAME, ExistingWorkPolicy.APPEND_OR_REPLACE, req)
        }

        fun liveInfo(context: Context) =
            WorkManager.getInstance(context).getWorkInfosForUniqueWorkLiveData(NAME)
    }
}
