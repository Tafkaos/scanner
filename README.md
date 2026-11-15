# Dokumentenscanner (Web-App)

Scannt mit der Handykamera, erkennt das Blatt, entzerrt es, gleicht die Beleuchtung aus, fasst mehrere Seiten zu einem PDF zusammen und legt es in Dropbox ab.

## Online stellen (einmalig, kostenlos) – GitHub Pages
1. Auf github.com ein neues Repository anlegen (z. B. `scanner`, öffentlich).
2. „Add file → Upload files“: ALLE Dateien dieses Ordners hochladen (auch `opencv.js`, 13 MB), „Commit“.
3. Settings → Pages → „Deploy from a branch“ → `main` / `/ (root)` → Save.
4. Nach 1–2 Minuten erreichbar unter `https://<dein-name>.github.io/scanner/`.
5. Am Handy öffnen: iPhone Safari → Teilen → „Zum Home-Bildschirm“; Android Chrome → Menü → „App installieren“.
(Alternative: Ordner per Drag & Drop auf app.netlify.com/drop ziehen.)

## Dropbox verbinden (einmalig)
Siehe in der App: ⚙︎ → „Einrichtung der Dropbox-Anbindung“. Kurz: App auf dropbox.com/developers/apps anlegen („Scoped access“, „App folder“), Berechtigung `files.content.write`, die in der App angezeigte Adresse als Redirect URI eintragen, App-Key in die App kopieren, „Mit Dropbox verbinden“.

## Bedienung
- Kamera: Blatt ins Bild halten, Rahmen wird live erkannt. Auslöser drücken oder „Auto“ einschalten (löst aus, sobald das Blatt ruhig liegt; danach nächstes Blatt hinlegen).
- Mehrere Seiten nacheinander aufnehmen, dann „Fertig“.
- Seite antippen: Ecken von Hand ziehen, Farbe/Grau/S-W/Original, drehen, Vorschau, löschen.
- „In Dropbox ablegen“ oder „PDF teilen / speichern“ (Teilen-Menü, z. B. direkt in die Dropbox-App).
- „Kamera-App“ nutzt die normale Kamera des Handys in voller Auflösung (beste Qualität, v. a. auf dem iPhone).

## Dateien
index.html, app.js, scanner-core.js (Programm) · opencv.js (OpenCV 5, Apache-2.0, siehe OPENCV-LICENSE.txt) · sw.js, manifest.webmanifest, icon-*.png (Installation/Offline)
