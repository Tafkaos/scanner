# Scanner – Android-App

Werbefreier Dokumentenscanner für den privaten Gebrauch. Scans landen als
mehrseitiges PDF automatisch in Dropbox.

- **Scannen:** Google ML Kit Document Scanner (automatische Kantenerkennung,
  Zuschnitt, Filter, Schatten-/Fleckentfernung, Galerie-Import). Läuft komplett
  auf dem Handy, braucht keine Kamera-Berechtigung.
- **Upload:** Im Hintergrund per WorkManager, sobald Internet da ist. Ohne Netz
  bleiben Scans in der Warteschlange und werden später automatisch hochgeladen.
- **Dropbox:** OAuth mit PKCE, kein App-Secret im Code. Dateiname
  `Scan JJJJ-MM-TT HH-MM-SS.pdf`, gleicher Name → Dropbox hängt „(1)“ an.

## Bauen

GitHub baut die App bei jedem Push in `android/` automatisch
(Workflow „Android-App bauen“). Die fertige APK liegt danach unter
**Releases → Scanner-App (neueste Version) → Scanner.apk**.

Lokal: `cd android && ./gradlew assembleRelease` (JDK 17, Android SDK 35).

## Einrichten auf dem Handy

1. `Scanner.apk` auf dem Handy herunterladen, öffnen, Installation aus dieser
   Quelle erlauben.
2. In der App unter *Dropbox-Verbindung* den App-Key eintragen
   (dropbox.com/developers/apps → deine App → *App key*).
   Benötigte Berechtigung der Dropbox-App: `files.content.write`.
3. *Bei Dropbox freigeben* → im Browser erlauben → angezeigten Code kopieren →
   in der App einfügen → *Code bestätigen*.

Hinweis: Der Signaturschlüssel in `keystore/` ist absichtlich fest eingecheckt,
damit sich Updates über die alte Version installieren lassen. Er ist nur für
diese private App gedacht.
