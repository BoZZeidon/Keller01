# MATERIALKELLER – Bestandsverwaltung mit QR-Etiketten

Web-App fürs Handy: Artikel verwalten, QR-Etiketten als PDF drucken,
per Kamera scannen, Excel-Export/-Import. Läuft auf deinem eigenen Server
(gleiches Prinzip wie Button Game: Node.js + Express + SQLite).

## Funktionen
- Artikel mit Artikelnummer, Name, Kiste, Menge, REF-Nr, Notiz
- Suche über alle Felder (Name, Nummer, Kiste, REF …)
- QR-Etiketten als druckfertiges A4-PDF (21 Etiketten pro Seite, einzeln oder Auswahl)
- QR-Scan in der App (Kamera) ODER mit jeder normalen Handykamera –
  der Code ist eine URL und öffnet den Artikel direkt
- Schnelles +/− für Mengen direkt am Artikel
- Excel-Export: Button „Excel-Bestand herunterladen" erzeugt jederzeit
  eine .xlsx mit dem aktuellen Bestand (immer automatisch aktuell)
- Excel-Import zum erstmaligen Befüllen (Spalten: Artikelnummer,
  Artikelname, Kiste, Menge, REF-Nr, Notiz – Reihenfolge egal)
- Als App installierbar (PWA): im Browser „Zum Startbildschirm hinzufügen"

## Voraussetzungen
- Node.js **22.5 oder neuer** (für eingebautes SQLite).
  Ältere Versionen funktionieren auch – dann speichert die App
  automatisch in `data/lager.json` statt SQLite.
- **HTTPS in Produktion ist Pflicht**: Browser geben die Kamera für den
  QR-Scanner nur über HTTPS frei (localhost ausgenommen).

## Installation
```bash
npm install
node server.js
```
Dann im Browser: http://localhost:3050

## Konfiguration (oben in server.js)
```js
PORT: 3050,
BASE_URL: ""   // <- WICHTIG vor dem Etikettendruck setzen!
```
`BASE_URL` ist die Adresse, die in die QR-Codes gedruckt wird,
z. B. `"https://lager.deine-domain.de"`. Wenn leer, wird die Adresse
aus dem Aufruf übernommen – für gedruckte Etiketten aber unbedingt
fest setzen, damit die Codes dauerhaft gültig bleiben.

## Betrieb auf dem Server (wie Button Game)
```bash
# z. B. mit pm2
pm2 start server.js --name materialkeller
```
Nginx-Beispiel als Reverse Proxy mit HTTPS:
```nginx
server {
    listen 443 ssl;
    server_name lager.deine-domain.de;
    location / { proxy_pass http://127.0.0.1:3050; }
}
```

## Daten
Alles liegt in `data/lager.db` (bzw. `lager.json`).
Backup = diese eine Datei kopieren.

## Hinweis Dienstgebrauch
Die App ist für den privaten Eigenbau gedacht. Wenn du damit dienstliches
Material verwaltest: vorher mit dem Spieß/IT-Sicherheit klären, auf welchem
Netz/Server das laufen darf, und keine eingestuften Informationen einpflegen.
