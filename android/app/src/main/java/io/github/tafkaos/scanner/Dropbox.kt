package io.github.tafkaos.scanner

import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom

/** Fehler, den Dropbox mit einem HTTP-Status zurückgemeldet hat. */
class DropboxException(val status: Int, val body: String) :
    IOException("Dropbox meldet $status: ${body.take(300)}")

/**
 * Schlanker Dropbox-Zugang ohne Fremdbibliothek:
 * Anmeldung per OAuth 2 mit PKCE (ohne App-Secret) und Datei-Upload.
 */
object Dropbox {
    private const val AUTH_URL = "https://www.dropbox.com/oauth2/authorize"
    private const val TOKEN_URL = "https://api.dropboxapi.com/oauth2/token"
    private const val UPLOAD_URL = "https://content.dropboxapi.com/2/files/upload"

    private fun b64url(bytes: ByteArray): String =
        Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    fun newVerifier(): String {
        val bytes = ByteArray(48)
        SecureRandom().nextBytes(bytes)
        return b64url(bytes) // 64 Zeichen, erlaubt sind 43–128
    }

    fun challengeFor(verifier: String): String =
        b64url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

    /** Ohne redirect_uri zeigt Dropbox nach der Freigabe einen Code an, den man in die App kopiert. */
    fun authUrl(appKey: String, verifier: String): String =
        AUTH_URL +
            "?client_id=" + enc(appKey) +
            "&response_type=code" +
            "&code_challenge=" + enc(challengeFor(verifier)) +
            "&code_challenge_method=S256" +
            "&token_access_type=offline"

    fun exchangeCode(appKey: String, code: String, verifier: String): JSONObject =
        postForm(
            TOKEN_URL,
            mapOf(
                "code" to code.trim(),
                "grant_type" to "authorization_code",
                "client_id" to appKey,
                "code_verifier" to verifier,
            ),
        )

    fun refresh(appKey: String, refreshToken: String): JSONObject =
        postForm(
            TOKEN_URL,
            mapOf(
                "grant_type" to "refresh_token",
                "refresh_token" to refreshToken,
                "client_id" to appKey,
            ),
        )

    /** Lädt [file] nach [path] hoch. Gibt es den Namen schon, hängt Dropbox „(1)“ usw. an. */
    fun upload(accessToken: String, path: String, file: File): JSONObject {
        val arg = JSONObject()
            .put("path", path)
            .put("mode", "add")
            .put("autorename", true)
            .put("mute", false)
        val con = open(UPLOAD_URL)
        try {
            con.requestMethod = "POST"
            con.doOutput = true
            con.setRequestProperty("Authorization", "Bearer $accessToken")
            con.setRequestProperty("Content-Type", "application/octet-stream")
            // HTTP-Header dürfen nur ASCII enthalten – Umlaute im Ordnernamen werden maskiert.
            con.setRequestProperty("Dropbox-API-Arg", asciiJson(arg.toString()))
            con.setFixedLengthStreamingMode(file.length())
            con.outputStream.use { out -> file.inputStream().use { it.copyTo(out, 64 * 1024) } }
            return readJson(con)
        } finally {
            con.disconnect()
        }
    }

    /** Ordner aus den Einstellungen + Dateiname → gültiger Dropbox-Pfad. */
    fun buildPath(folder: String, fileName: String): String {
        val parts = folder.replace('\\', '/').split('/').map { it.trim() }.filter { it.isNotEmpty() }
        return (if (parts.isEmpty()) "" else "/" + parts.joinToString("/")) + "/" + fileName
    }

    /** Ersetzt jedes Nicht-ASCII-Zeichen durch \uXXXX (so verlangt es Dropbox für den Header). */
    fun asciiJson(json: String): String {
        val sb = StringBuilder(json.length + 16)
        for (ch in json) {
            if (ch.code < 0x80) sb.append(ch) else sb.append(String.format("\\u%04x", ch.code))
        }
        return sb.toString()
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    private fun open(url: String): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 120_000
        }

    private fun postForm(url: String, form: Map<String, String>): JSONObject {
        val body = form.entries.joinToString("&") { enc(it.key) + "=" + enc(it.value) }
            .toByteArray(Charsets.UTF_8)
        val con = open(url)
        try {
            con.requestMethod = "POST"
            con.doOutput = true
            con.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            con.setFixedLengthStreamingMode(body.size)
            con.outputStream.use { it.write(body) }
            return readJson(con)
        } finally {
            con.disconnect()
        }
    }

    private fun readJson(con: HttpURLConnection): JSONObject {
        val status = con.responseCode
        val stream = if (status in 200..299) con.inputStream else con.errorStream
        val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
        if (status !in 200..299) throw DropboxException(status, text)
        return JSONObject(text)
    }
}
