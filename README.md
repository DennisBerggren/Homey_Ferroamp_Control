# Ferroamp Control — Homey App

En Homey-app för att styra och övervaka Ferroamp EnergyHub via Ferroamp Portal API. Appen ger dig samma kontroll som du har i portalen, direkt från Homey Flows — plus realtidsdata om solproduktion, grid-flöde, batteristatus och hemförbrukning.

> Baserad på reverse engineering av Ferroamp Portal API, inspirerad av [@jonasbkarlsson](https://github.com/jonasbkarlsson/ferroamp_operation_settings) för Home Assistant.

---

## Funktioner

### Live-data (uppdateras var 60:e sekund)
| Capability | Beskrivning |
|---|---|
| Grid (+ import / - export) | Effekt mot elnätet i W. Negativt = du exporterar. |
| Solar Production | Solproduktion i W (summa av alla PV-strängar) |
| Battery (+ charging / - discharging) | Batterieffekt i W. Positivt = laddar. |
| Home Consumption | Hemförbrukning i W |
| Battery SOC | Laddningsnivå i % (medelvärde av alla ESO-enheter) |

### Styrning via Flow Cards (Then...)
| Flow Card | Beskrivning |
|---|---|
| Charge Battery | Laddar batteriet med angiven effekt (W) |
| Discharge Battery | Laddar ur batteriet med angiven effekt (W) |
| Set Self-Consumption | Sätter Self-Consumption-läge med valfria parametrar |
| Set Peak Shaving | Sätter Peak Shaving-läge med valfria tröskelvärden |
| Set Solar Production (PV) | Slår på/av solproduktion |
| Limit Export of Solar | Aktiverar/deaktiverar export-begränsning |
| Use only Solar for EV Charging | Aktiverar/deaktiverar Limit Import |
| Set HEMS Mode | Tar emot kommandon från en HEMS-controller |
| Configure Ferroamp System | Avancerat kort med full kontroll över alla inställningar |

---

## Installation

### Krav
- Homey Pro (SDK 3)
- Konto på [portal.ferroamp.com](https://portal.ferroamp.com)
- Ditt System-ID (hittas i URL:en på portalen: `?id=XXXX`)

### Lägg till enheten
1. Öppna Homey → **Devices** → **+** → **Ferroamp Control** → **Ferroamp EnergyHub**
2. Ange **System-ID**, **e-postadress** och **lösenord** för Ferroamp Portal
3. Klicka **Login** — enheten läggs till automatiskt
4. Enheten heter nu **Ferroamp EnergyHub (XXXX)** i din zon

---

## Flow Cards — Detaljerad beskrivning

### Charge Battery
Sätter Ferroamp i Manual-läge och laddar batteriet med angiven effekt. Discharge reference sätts automatiskt till 0.

```
Driftläge: Default (Manual)
Battery Power: Charge
Parameter: Effekt i W (0–15000)
```

**Exempel:** Ladda med 5000 W när elpriset är lågt.

---

### Discharge Battery
Sätter Ferroamp i Manual-läge och laddar ur batteriet med angiven effekt. Charge reference sätts automatiskt till 0.

```
Driftläge: Default (Manual)
Battery Power: Discharge
Parameter: Effekt i W (0–15000)
```

**Exempel:** Ladda ur 3000 W under dyr timme.

---

### Set Self-Consumption
Sätter Self-Consumption-läge. Batteriet laddar automatiskt från sol och laddar ur för att täcka husets förbrukning.

```
Driftläge: Self Consumption (mode 3)
Parametrar (alla valfria — lämna tomt för att behålla befintligt):
  Discharge Reference (W)
  Charge Reference (W)  
  Min Battery SOC (%)
  Max Battery SOC (%)
```

---

### Set Peak Shaving
Sätter Peak Shaving-läge. Batteriet laddar ur automatiskt när grid-import överstiger tröskeln.

```
Driftläge: Peak Shaving (mode 2)
Parametrar (alla valfria):
  Import Threshold (W)    — batteriet börjar ladda ur när import överstiger detta
  Export Threshold (W)    — batteriet börjar ladda när export överstiger detta
  Discharge Reference (W)
  Charge Reference (W)
  Min Battery SOC (%)
  Max Battery SOC (%)
```

---

### Set HEMS Mode
Designat för integration med en extern HEMS-controller. Tar emot ett kommando som text och en valfri effekt i W.

| Kommando | Beskrivning |
|---|---|
| `charge` | Manual-läge, ladda batteriet med angiven effekt |
| `export` | Manual-läge, ladda ur batteriet med angiven effekt |
| `selfconsumption` | Self-Consumption, max charge och discharge |
| `chargesolar` | Alias för selfconsumption |
| `sellsolar` | Self-Consumption, ladda ur men ladda inte |
| `pause` | Manual-läge, batteriet av |
| `peakshaving` | Peak Shaving med effekt som discharge-tröskel |
| `zeroexport` | Self-Consumption + Limit Export aktiverat |
| `unchanged` | Gör ingenting (hoppa över) |

---

### Configure Ferroamp System
Det mest kompletta flow card:et — ger full kontroll över alla inställningar i ett enda kort. Välj "Keep current" på parametrar du inte vill ändra.

```
1. Operation Mode         (Default / Peak Shaving / Self Consumption / Keep current)
2. Battery Mode           (Off / Charge / Discharge / Keep current) — Default-läge
3. Charge Power (W)
4. Discharge Power (W)
5. Min Battery SOC (%)
6. Max Battery SOC (%)
7. Solar (PV)             (On / Off / Keep current)
8. Phase Balancing (ACE)  (On / Off / Keep current)
9. ACE Threshold (A)
10. Limit Grid Import     (On / Off / Keep current)
11. Import Threshold (W)
12. Limit Grid Export     (On / Off / Keep current)
13. Export Threshold (W)
14. Discharge Threshold (W) — Peak Shaving
15. Charge Threshold (W)    — Peak Shaving
```

---

## Exempel på Flows

### Ladda batteriet nattetid när priset är lågt
```
When:  Electricity price drops below 0.50 kr
Then:  Charge Battery at 8000 W
```

### Ladda ur under dyr timme
```
When:  Electricity price rises above 2.00 kr
Then:  Discharge Battery at 5000 W
```

### Självförbrukning på dagen
```
When:  Time is 07:00
Then:  Set Self-Consumption (Discharge 10000 W, Charge 10000 W, SOC 10-95%)
```

### Peak Shaving vid höglast
```
When:  Time is 07:00 on weekdays
Then:  Set Peak Shaving (Import Threshold 3500 W, Discharge 8000 W)
```

### Stoppa export om priset är negativt
```
When:  Electricity price drops below 0 kr
Then:  Configure Ferroamp: Limit Grid Export = On
```

---

## Live-data och Homey Energy

Appen pollar Ferroamp Portal var 60:e sekund och uppdaterar capabilities på enheten. Dessa värden kan användas i:

- **Homey Energy-tabben** — solproduktion och batteristatus syns automatiskt
- **Flow conditions** — "When Solar Production changes" osv (kräver Homey Pro med Advanced Flows)
- **Widgets** — visa aktuell effekt direkt på device-kortet

### Notering om Grid-värdet
Grid-effekten beräknas från energibalansen (`Solar - Consumption - Battery = Grid`) eftersom Ferroamp Portal API inte returnerar grid-effekten direkt som ett fält. Värdet är normalt within ~100W från portalens visning.

---

## Teknisk information

### Autentisering
Appen använder OAuth2 PKCE-flödet mot Ferroamp Portal (samma som webbläsaren). Tokens sparas krypterat i Homeys store och förnyas automatiskt via refresh token utan att behöva logga in igen.

### API-endpoints
| Endpoint | Användning |
|---|---|
| `auth.eu.prod.ferroamp.com` | OAuth2 autentisering |
| `api.eu.prod.ferroamp.com/settings/topology/get` | Live-data (SOC, solar, battery, consumption) |
| `portal.ferroamp.com/service/ems-config/v1/current` | Hämta aktuell konfiguration |
| `portal.ferroamp.com/service/ems-config/v1/commands/set` | Skicka konfiguration |

### Filstruktur
```
app.js                    — App-initiering
ferroamp-homey-api.js     — API-klient (autentisering, getStatus, getConfig, setConfig)
drivers/
  energyhub/
    driver.js             — Parning av enhet
    device.js             — Enhetens logik, polling, flow card-hantering
    assets/
      images/             — Enhetsbilder
    pair/
      login.html          — Inloggningsvy vid parning
```

---

## Felsökning

### Enheten visas som offline
Tokens kan ha gått ut. Ta bort och lägg till enheten igen.

### pollStatus failed: invalid json
API-URL:en kan ha ändrats av Ferroamp. Kontrollera `getStatus()`-metoden i `ferroamp-homey-api.js` och jämför med nätverkstrafiken i webbläsaren (DevTools → Network → `get?facility_id=`).

### Konfiguration appliceras inte
Kontrollera att System-ID stämmer och att kontot har behörighet att ändra inställningar i portalen.

---

## Bidra

Pull requests välkomnas! Särskilt intressant:
- Config-polling med trigger-kort vid förändringar
- Stöd för fler Ferroamp-produkter
- Förbättrad felhantering

---

## Licens

MIT — se [LICENSE](LICENSE)

## Tack

- [@jonasbkarlsson](https://github.com/jonasbkarlsson) för [ferroamp_operation_settings](https://github.com/jonasbkarlsson/ferroamp_operation_settings) (Home Assistant) som inspirerade detta projekt
- Ferroamp för ett välbyggt energisystem 🌞

## Disclaimer

Denna app är inte officiell och stöds inte av Ferroamp AB. Använd på egen risk.
