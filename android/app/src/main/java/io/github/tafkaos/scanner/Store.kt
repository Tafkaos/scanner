package io.github.tafkaos.scanner

import android.content.Context
import org.json.JSONArray
import java.io.File

/** Einstellungen, Dropbox-Zugang und Verlauf – alles nur im privaten App-Speicher. */
class Store(context: Context) {
    private val app = context.applicationContext
    private val p = app.getSharedPreferences("scanner", Context.MODE_PRIVATE)

    var appKey: String
        get() = p.getString("appKey", "") ?: ""
        set(v) = p.edit().putString("appKey", v.trim()).apply()

    var folder: String
        get() = p.getString("folder", "/Scans") ?: "/Scans"
        set(v) = p.edit().putString("folder", v.trim()).apply()

    var autoStart: Boolean
        get() = p.getBoolean("autoStart", true)
        set(v) = p.edit().putBoolean("autoStart", v).apply()

    var verifier: String
        get() = p.getString("verifier", "") ?: ""
        set(v) = p.edit().putString("verifier", v).apply()

    val connected: Boolean get() = refreshToken.isNotEmpty() && appKey.isNotEmpty()

    var refreshToken: String
        get() = p.getString("refresh", "") ?: ""
        private set(v) = p.edit().putString("refresh", v).apply()

    fun saveTokens(refresh: String?, access: String, expiresInSec: Long) {
        val e = p.edit()
        if (!refresh.isNullOrEmpty()) e.putString("refresh", refresh)
        e.putString("access", access)
        e.putLong("accessExp", System.currentTimeMillis() + expiresInSec * 1000)
        e.apply()
    }

    fun disconnect() {
        p.edit().remove("refresh").remove("access").remove("accessExp").remove("verifier").apply()
    }

    /** Gültiges Zugriffstoken; erneuert es bei Bedarf über das Refresh-Token. */
    @Synchronized
    fun accessToken(force: Boolean = false): String {
        val access = p.getString("access", "") ?: ""
        val exp = p.getLong("accessExp", 0)
        if (!force && access.isNotEmpty() && exp > System.currentTimeMillis() + 60_000) return access
        val r = Dropbox.refresh(appKey, refreshToken)
        val token = r.getString("access_token")
        saveTokens(null, token, r.optLong("expires_in", 14_400))
        return token
    }

    // ---- Verlauf (die letzten 30 Einträge)
    fun history(): List<String> {
        val a = JSONArray(p.getString("history", "[]"))
        return (0 until a.length()).map { a.getString(it) }
    }

    @Synchronized
    fun addHistory(line: String) {
        val list = (listOf(line) + history()).take(30)
        p.edit().putString("history", JSONArray(list).toString()).apply()
    }

    @Synchronized
    fun setLastError(msg: String?) {
        p.edit().putString("lastError", msg ?: "").apply()
    }

    val lastError: String get() = p.getString("lastError", "") ?: ""

    // ---- Warteschlange: PDFs, die noch hochgeladen werden müssen
    val pendingDir: File get() = File(app.filesDir, "pending").apply { mkdirs() }

    fun pending(): List<File> =
        pendingDir.listFiles { f -> f.isFile && f.name.endsWith(".pdf") }
            ?.sortedBy { it.name } ?: emptyList()
}
