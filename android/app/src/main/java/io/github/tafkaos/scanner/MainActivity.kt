package io.github.tafkaos.scanner

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.lifecycleScope
import com.google.mlkit.vision.documentscanner.GmsDocumentScanner
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : ComponentActivity() {

    private lateinit var store: Store
    private lateinit var scanner: GmsDocumentScanner

    private lateinit var txtStatus: TextView
    private lateinit var txtError: TextView
    private lateinit var txtHistory: TextView
    private lateinit var btnRetry: Button
    private lateinit var editFolder: EditText
    private lateinit var editKey: EditText
    private lateinit var editCode: EditText
    private lateinit var chkAuto: CheckBox
    private lateinit var boxConnect: LinearLayout
    private lateinit var btnDisconnect: Button

    private val scanLauncher =
        registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { res ->
            if (res.resultCode != Activity.RESULT_OK) return@registerForActivityResult
            val pdfUri = GmsDocumentScanningResult.fromActivityResultIntent(res.data)?.pdf?.uri
            if (pdfUri == null) {
                toast("Kein PDF erhalten.")
                return@registerForActivityResult
            }
            savePdf(pdfUri)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        store = Store(this)

        // Vollmodus: automatische Kantenerkennung, Zuschnitt, Filter, Schatten/Flecken entfernen,
        // beliebig viele Seiten, Import aus der Galerie. Ergebnis: ein mehrseitiges PDF.
        val options = GmsDocumentScannerOptions.Builder()
            .setGalleryImportAllowed(true)
            .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_PDF)
            .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
            .build()
        scanner = GmsDocumentScanning.getClient(options)

        txtStatus = findViewById(R.id.txtStatus)
        txtError = findViewById(R.id.txtError)
        txtHistory = findViewById(R.id.txtHistory)
        btnRetry = findViewById(R.id.btnRetry)
        editFolder = findViewById(R.id.editFolder)
        editKey = findViewById(R.id.editKey)
        editCode = findViewById(R.id.editCode)
        chkAuto = findViewById(R.id.chkAuto)
        boxConnect = findViewById(R.id.boxConnect)
        btnDisconnect = findViewById(R.id.btnDisconnect)

        editFolder.setText(store.folder)
        editKey.setText(store.appKey)
        chkAuto.isChecked = store.autoStart
        findViewById<TextView>(R.id.txtVersion).text =
            "Version ${packageManager.getPackageInfo(packageName, 0).versionName}"

        findViewById<Button>(R.id.btnScan).setOnClickListener { startScan() }
        btnRetry.setOnClickListener { UploadWorker.enqueue(this); toast("Upload gestartet.") }
        chkAuto.setOnCheckedChangeListener { _, on -> store.autoStart = on }
        findViewById<Button>(R.id.btnAuth).setOnClickListener { openDropboxAuth() }
        findViewById<Button>(R.id.btnCode).setOnClickListener { confirmCode() }
        btnDisconnect.setOnClickListener {
            store.disconnect()
            toast("Dropbox getrennt.")
            refresh()
        }

        UploadWorker.liveInfo(this).observe(this) { refresh() }
        refresh()

        // Wer die App öffnet, will meistens scannen – also gleich loslegen.
        if (savedInstanceState == null && store.autoStart && store.connected) startScan()
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    override fun onPause() {
        super.onPause()
        store.folder = editFolder.text.toString().ifBlank { "/Scans" }
        store.appKey = editKey.text.toString()
    }

    private fun startScan() {
        scanner.getStartScanIntent(this)
            .addOnSuccessListener { sender ->
                scanLauncher.launch(IntentSenderRequest.Builder(sender).build())
            }
            .addOnFailureListener { e ->
                toast("Scanner konnte nicht starten: ${e.message}\n(Google-Play-Dienste aktuell?)")
            }
    }

    /** PDF aus dem Scanner in die Warteschlange kopieren und den Upload anstoßen. */
    private fun savePdf(uri: Uri) {
        val name = "Scan " + SimpleDateFormat("yyyy-MM-dd HH-mm-ss", Locale.GERMANY).format(Date()) + ".pdf"
        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    val tmp = File(store.pendingDir, "$name.part")
                    contentResolver.openInputStream(uri)!!.use { input ->
                        tmp.outputStream().use { input.copyTo(it) }
                    }
                    if (!tmp.renameTo(File(store.pendingDir, name))) error("Datei konnte nicht abgelegt werden")
                }
                UploadWorker.enqueue(this@MainActivity)
                toast(if (store.connected) "Gescannt – wird hochgeladen …" else "Gescannt. Für den Upload bitte Dropbox verbinden.")
            } catch (e: Exception) {
                toast("Speichern fehlgeschlagen: ${e.message}")
            }
            refresh()
        }
    }

    /** Dropbox-App-Keys bestehen nur aus Kleinbuchstaben und Ziffern. */
    private fun checkedKey(): String? {
        val key = editKey.text.toString().trim()
        if (key.isEmpty()) {
            toast("Bitte zuerst den App-Key eintragen.")
            return null
        }
        if (!Regex("^[a-z0-9]{8,32}$").matches(key)) {
            showError("Der App-Key „$key“ enthält unzulässige Zeichen (erlaubt: a–z, 0–9). " +
                "Bitte aus der Dropbox-Konsole kopieren statt abtippen.")
            return null
        }
        return key
    }

    private fun showError(msg: String) {
        store.setLastError(msg)
        toast(msg)
        refresh()
    }

    private fun openDropboxAuth() {
        val key = checkedKey() ?: return
        store.appKey = key
        val verifier = Dropbox.newVerifier()
        store.verifier = verifier
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(Dropbox.authUrl(key, verifier))))
        } catch (e: ActivityNotFoundException) {
            toast("Kein Browser gefunden.")
        }
    }

    private fun confirmCode() {
        val code = editCode.text.toString().trim()
        val key = checkedKey() ?: return
        val verifier = store.verifier
        if (code.isEmpty() || verifier.isEmpty()) {
            toast("Erst „Bei Dropbox freigeben“ tippen, dann den Code einfügen.")
            return
        }
        lifecycleScope.launch {
            try {
                val r = withContext(Dispatchers.IO) { Dropbox.exchangeCode(key, code, verifier) }
                store.appKey = key
                store.saveTokens(
                    r.getString("refresh_token"),
                    r.getString("access_token"),
                    r.optLong("expires_in", 14_400),
                )
                store.verifier = ""
                store.setLastError(null)
                editCode.setText("")
                toast("Dropbox verbunden ✔")
                UploadWorker.enqueue(this@MainActivity) // evtl. wartende Scans jetzt hochladen
            } catch (e: Exception) {
                val hint = if (e is DropboxException && e.body.contains("invalid_grant"))
                    "\nDer Code ist abgelaufen, schon benutzt oder gehört zu einem anderen Versuch. " +
                        "Bitte erneut „Bei Dropbox freigeben“ tippen und den neuen Code nehmen."
                else ""
                showError("Verbindung fehlgeschlagen: ${e.message}$hint")
            }
            refresh()
        }
    }

    private fun refresh() {
        if (!::store.isInitialized) return
        val waiting = store.pending().size
        val connected = store.connected
        txtStatus.text = buildString {
            append(if (connected) "Dropbox verbunden – Ordner: ${store.folder}" else "Dropbox noch nicht verbunden (siehe unten).")
            append("\n")
            append(
                when (waiting) {
                    0 -> "Keine Scans in der Warteschlange."
                    1 -> "1 Scan wartet auf den Upload."
                    else -> "$waiting Scans warten auf den Upload."
                },
            )
        }
        val err = store.lastError
        txtError.text = err
        txtError.visibility = if (err.isNotEmpty() && (waiting > 0 || !connected)) View.VISIBLE else View.GONE
        btnRetry.visibility = if (waiting > 0 && connected) View.VISIBLE else View.GONE
        txtHistory.text = store.history().joinToString("\n").ifEmpty { "–" }
        boxConnect.visibility = if (connected) View.GONE else View.VISIBLE
        btnDisconnect.visibility = if (connected) View.VISIBLE else View.GONE
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
}
