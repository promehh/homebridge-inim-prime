# homebridge-inim-prime

Plugin **Homebridge** per centrali antifurto **INIM** (testato concettualmente su **Prime / Prime60**, compatibile anche con **SmartLiving**) tramite **INIM Cloud**, con aggiornamenti in tempo reale via **WebSocket** e supporto opzionale **SIA-IP** locale.

Espone su HomeKit:

- un **Security System** per ogni Area configurata (oppure uno globale, a scelta);
- uno **Switch** per ogni Scenario della centrale (Totale, Notte, Perimetrale, ...);
- un **Contact Sensor** o **Motion Sensor** per ogni zona (porte, finestre, PIR).

Niente altro - né diagnostica, né termostati, né dati di rete. Solo allarme, aree, scenari, zone.

> Questo plugin è derivato (clean-room rewrite in TypeScript) dall'analisi del protocollo della custom integration [pla10/homeassistant_inim_alarm](https://github.com/pla10/homeassistant_inim_alarm) (MIT). Non è affiliato con INIM Electronics S.p.A. INIM, Prime e SmartLiving sono marchi dei rispettivi proprietari.

---

## Requisiti

- Una centrale INIM (Prime, Prime60, SmartLiving) **associata a un account INIM Cloud**.
- Il **PIN utente della centrale** (quello che useresti su una tastiera). Non è la password del cloud.
- **Homebridge 1.6+** (o 2.0 beta) e **Node.js 18.17+ / 20 / 22**.
- Una **Raspberry Pi 64-bit** (o qualunque host Homebridge): il plugin è puro Node, gira ovunque.

---

## Installazione

### Via Homebridge UI (consigliato dopo la prima pubblicazione su npm)

1. Apri la **Homebridge UI**.
2. Tab **Plugins** → cerca `homebridge-inim-prime`.
3. **Install** → poi clicca **Settings** sul plugin e compila i campi.

### Via GitHub (prima della pubblicazione su npm)

Sulla Raspberry, da terminale:

```bash
sudo npm install -g github:TUO_USERNAME/homebridge-inim-prime
sudo systemctl restart homebridge
```

Lo script di `prepare` compila automaticamente i sorgenti TypeScript dopo il clone.

### Via tarball locale

Se hai ricevuto un `.tgz` o uno zip:

```bash
# se hai uno zip
unzip homebridge-inim-prime.zip
cd homebridge-inim-prime
npm install
npm run build
sudo npm install -g .
sudo systemctl restart homebridge
```

---

## Test della connessione prima di configurare Homebridge

Questo è il passo **più importante** del debug. Esegue tutto il flusso (login, snapshot, WebSocket) senza Homebridge di mezzo, e stampa gli **ID di tutti i device, le aree, gli scenari e le zone** della tua centrale. Ti serviranno per il `sceneMapping`.

```bash
cd /path/dove/hai/messo/il/plugin
npm install
npm run build
INIM_USER=tu@example.com INIM_PASS='lapasswordcloud' node dist/scripts/test-connection.js --ws
```

Output atteso (esempio):

```
[INFO ] Step 1/3: authenticating…
[INFO ] Authenticated OK.
[INFO ] Step 2/3: RequestPoll for all devices, wait 5s…
[INFO ] Step 3/3: GetDevicesExtended…
[INFO ] Found 1 device(s).

═══════════════════════════════════════════════════════
Device  id=12345  name="Casa"  model=Prime 60  fw=4.10
  ActiveScenario: 1

  Areas (3):
    - AreaId=0  name="Perimetrale PT"  disarmed
    - AreaId=1  name="Notte P1"        disarmed
    - AreaId=2  name="Garage"          disarmed

  Scenarios (4):
    - ScenarioId=0  name="Totale"
    - ScenarioId=1  name="Disinserito"   <- active
    - ScenarioId=2  name="Notte"
    - ScenarioId=3  name="Perimetrale"

  Zones (12):
    - ZoneId=0  name="Porta ingresso"  closed  areas=[0]
    - ZoneId=1  name="Finestra cucina" closed  areas=[0]
    - ZoneId=2  name="PIR salotto"     closed  areas=[0]
    ...
═══════════════════════════════════════════════════════
```

Se vedi questo output, **la connessione funziona** e puoi passare alla configurazione di Homebridge. Tieni a portata di mano questi ID.

Aggiungi `--verbose` per il debug verboso (mostra tutte le chiamate HTTP). Aggiungi `--ws` per restare in ascolto sul WebSocket per 60 secondi e vedere gli eventi in tempo reale (apri/chiudi una porta per testare).

---

## Configurazione

Esempio di `config.json` (sezione `platforms[]`):

```json
{
  "platform": "InimPrime",
  "name": "INIM Prime",
  "username": "tu@example.com",
  "password": "la-password-del-cloud",
  "userCode": "1234",
  "pollIntervalSeconds": 60,
  "zoneMapping": "auto",
  "exposeExtraSceneSwitches": true,
  "areaMode": "perArea",
  "sceneMapping": {
    "stayScenarioId": 3,
    "awayScenarioId": 0,
    "nightScenarioId": 2,
    "disarmScenarioId": 1
  },
  "useSiaIp": false,
  "siaIpPort": 6001,
  "debug": true
}
```

### Campi

| Campo | Obbligatorio | Default | Descrizione |
|---|---|---|---|
| `username` | sì | — | Email dell'account INIM Home / InimCloud. |
| `password` | sì | — | Password del cloud. |
| `userCode` | sì | — | PIN utente della centrale (richiesto per arm/disarm). |
| `pollIntervalSeconds` | no | `60` | Intervallo di polling REST come fallback (il WebSocket dà già gli aggiornamenti real-time). Minimo 15s. |
| `zoneMapping` | no | `"auto"` | `auto` (euristica nome), `contact`, `motion`, `none`. |
| `exposeExtraSceneSwitches` | no | `true` | Crea uno Switch per ogni scenario INIM. |
| `areaMode` | no | `"perArea"` | `perArea` (consigliato), `globalOnly`, `globalPlusSwitches`. |
| `sceneMapping` | no | `{}` | Mappa gli scenari INIM sugli stati HomeKit del Security System globale. |
| `useSiaIp` | no | `false` | Abilita ricezione push locale via SIA-IP (richiede config sulla centrale). |
| `siaIpPort` | no | `6001` | Porta TCP su cui ascoltare. |
| `siaAccountId` | no | — | Filtro account per i frame SIA. |
| `debug` | no | `false` | Log verbosi. **Abilitalo alla prima installazione.** |

### Modalità aree

- **`perArea`** (consigliato): ogni Area diventa un Security System a sé. In HomeKit puoi inserire/disinserire separatamente "Perimetrale", "Notte", "Garage". Limite: ogni area-Security System può solo armarsi/disarmarsi del tutto (l'API non permette inserimenti parziali per singola area).
- **`globalOnly`**: un solo Security System che rappresenta tutto. Per le modalità HomeKit Stay/Away/Night, usa i `sceneMapping` per indicare gli ScenarioId della centrale.
- **`globalPlusSwitches`**: un Security System globale **più** uno Switch per ogni area.

### Mappatura scenari → HomeKit

Apple Home conosce 3 stati di inserimento: **Stay** (Casa), **Away** (Fuori) e **Night** (Notte). Indica nel `sceneMapping` quale `ScenarioId` della tua centrale corrisponde a quale stato. Per il **disinserimento**, puoi opzionalmente indicare un `disarmScenarioId` (utile se nella tua centrale "disinserisci" è uno scenario dedicato).

Se non imposti `sceneMapping`, il Security System globale userà `InsertAreas` con tutte le aree (arm/disarm completo).

Gli `ScenarioId` li trovi con lo script `test-connection.js`.

---

## Pubblicare il plugin su GitHub

Dalla cartella del progetto:

```bash
git init
git branch -m main
git add .
git commit -m "Initial release"
git remote add origin git@github.com:TUO_USERNAME/homebridge-inim-prime.git
git push -u origin main
```

Modifica prima `package.json` e sostituisci `REPLACE_WITH_YOUR_USERNAME` con il tuo username GitHub (campi `repository.url` e `bugs.url`).

### Pubblicare su npm (opzionale, per apparire nella Homebridge UI)

```bash
npm login
npm publish --access public
```

Una volta su npm, basta cercare il plugin nella Homebridge UI.

---

## Installazione su Raspberry Pi 64-bit, passo per passo

Se non hai ancora Homebridge:

```bash
# Installa Node.js LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Installa Homebridge + UI (consigliato il pacchetto ufficiale)
# Vedi https://github.com/homebridge/homebridge/wiki/Install-Homebridge-on-Raspbian
sudo npm install -g --unsafe-perm homebridge homebridge-config-ui-x
sudo hb-service install --user homebridge
```

Poi installa il plugin (dopo aver pushato il repo):

```bash
sudo npm install -g github:TUO_USERNAME/homebridge-inim-prime
sudo hb-service restart
```

Apri la **Homebridge UI** ( `http://raspberrypi.local:8581` ), tab **Plugins**, configura.

Per controllare i log live:

```bash
sudo hb-service logs
```

Filtra le righe del plugin con `grep -i inim`.

---

## SIA-IP (opzionale, push locale)

SIA-IP permette alla centrale di notificare al plugin **in tempo reale** gli eventi (arm/disarm, allarmi, restore zone), senza dipendere dal cloud. È utile se:

- vuoi reattività < 1 secondo;
- la rete della Raspberry è raggiungibile dalla centrale (stessa LAN o tunnel).

### Configurazione lato centrale

Usa **SmartLeague** (software per installatori INIM):

1. Vai sulla pagina del modulo IP della centrale.
2. Imposta il **destinatario SIA** sull'IP della Raspberry e la porta scelta (es. `6001`).
3. Imposta il **formato** su SIA-DC09 (non Contact ID).
4. Imposta un **Account ID** numerico (es. `001`).

Poi nel `config.json`:

```json
"useSiaIp": true,
"siaIpPort": 6001,
"siaAccountId": "001"
```

Se la centrale e la Raspberry sono in subnet diverse, dovrai aprire il port-forward o usare WireGuard/Tailscale. Se è troppo complicato lascialo disabilitato: il WebSocket basta a coprire la maggior parte dei casi reali.

---

## Risoluzione problemi

### "Missing required config field(s): ..."
Stai dimenticando `username`, `password` o `userCode` nel `config.json`. Apri Homebridge UI → Settings.

### "Authentication failed (Status=...)"
Credenziali cloud sbagliate. Verifica facendo login sull'app INIM Home dal cellulare.

### "INIM Cloud error code 21 / 22 / ..."
Codici applicativi non documentati da INIM. I più probabili:
- `21`-`26`: PIN utente sbagliato (la centrale rifiuta l'arm/disarm). Controlla `userCode`.
- Altri: vai sull'app, fai il login, riprova.

### Le zone non compaiono
- Verifica `zoneMapping` (se è `none`, sono volutamente nascoste).
- Le zone con `Visibility=0` sulla centrale sono nascoste anche qui.
- Nel log di Homebridge con `debug=true` cerca "Added accessory" - se non c'è, controlla che la centrale abbia restituito le zone (lancia `test-connection.js`).

### "WebSocket error" frequenti
- Rete instabile / proxy.
- Cloud INIM in manutenzione. Il plugin riprova ogni 10 secondi. Il polling REST ti copre intanto.

### Comandi arm/disarm partono in HomeKit ma la centrale non risponde
- Quasi sempre `userCode` errato.
- Abilita `debug: true`, riprova, e cerca nel log le chiamate `InsertAreas` - lì vedrai il codice di errore restituito dalla centrale.

### "RequestPoll failed"
La centrale è offline / non risponde al cloud. Il plugin continua usando l'ultimo snapshot conosciuto. Quando torna online la prossima poll ricarica tutto.

### Posso usare il plugin senza WebSocket?
Sì. Il WebSocket è additivo. Se per qualche motivo non funziona, il polling REST (default 60s) garantisce comunque l'aggiornamento. Per disabilitare di fatto il WS dovresti bloccare l'host `ws.inimcloud.com` a livello di firewall - non consigliato.

### Posso aggiornare lo stato HomeKit più velocemente?
Riduci `pollIntervalSeconds` (min 15s). Considera però che ogni poll = 1 chiamata cloud + 5s di attesa + 1 chiamata cloud. Sotto i 30s rischi di stressare i server INIM.

---

## Architettura del plugin

```
+--------------------------+        wss://ws.inimcloud.com/events
|  InimWebSocket           |  <----------------------------------+
|   ping "@ " ogni 115s    |                                     |
|   parse EVENT.Data.Data  |                                     |
+-----------+--------------+                                     |
            |                                                    |
            v                          GET https://api.inimcloud.com/?req=...
+--------------------------+  REST  +--------------------------+
|  Coordinator             |<------>|  InimClient (token+auth)  |
|  - cache devices         |        +--------------------------+
|  - merge WS/SIA updates  |
|  - poll loop (60s)       |
+-----------+--------------+
            |
            | "change" events
            v
+--------------------------+
|  Accessories (HomeKit)   |   <-- SecuritySystem / Switch / ContactSensor / MotionSensor
+--------------------------+
            ^
            | (opzionale)
+--------------------------+
|  SiaServer (TCP 0.0.0.0) |  <--- SIA-DC09 push locale dalla centrale
+--------------------------+
```

---

## Licenza

MIT (vedi `LICENSE`). Questo lavoro deriva dall'analisi della Home Assistant integration [pla10/homeassistant_inim_alarm](https://github.com/pla10/homeassistant_inim_alarm), copyright (c) 2026 Placido Falqueto, licenza MIT - vedi `NOTICE`.

## Disclaimer

Plugin non ufficiale, non supportato da INIM Electronics. L'uso è a tuo rischio. La protezione fisica di casa **non deve dipendere** da un'integrazione HomeKit: l'allarme funziona già autonomamente, questo plugin è solo un comodo telecomando aggiuntivo.
