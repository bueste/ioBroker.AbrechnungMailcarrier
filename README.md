# ioBroker.AbrechnungMailcarrier

Delivers the daily consumption per apartment, split into own solar power and grid power, to the
Abrechnung Mailcarrier billing web application over an authenticated HTTPS API.

The adapter does not talk to a database and needs no tunnel into the network of the web application.
It only makes outgoing HTTPS requests. Every property (client) of the web application has its own API
token, so one ioBroker can never write into the data of another client.

## How it works

```
iobroker.solarlog  --journal state-->  AbrechnungMailcarrier  --HTTPS-->  web application (client A)
Shelly / inverter  --energy states-->  AbrechnungMailcarrier  --HTTPS-->  web application (client B)
```

1. A **source** produces one *day record* per day: for every apartment the consumption, the solar share and
   the grid share, plus the building totals (production, consumption, feed-in).
2. The day records are kept in a local journal (state `data.journal`, 120 days).
3. A **delivery** asks the server which days it already has (`status.php`), builds the rows for the days it
   lacks and sends them (`ingest.php`). The server stores them in one transaction. Because the server says
   what it lacks, an outage, a lost response or a restored server database are all made up for by the next
   run, and nothing the server already holds is overwritten with older local values. Only the two most
   recent days are always repeated, so a late correction arrives.

Delivery runs when the source has new data, 10 seconds after start, every 10 minutes as a safety net (the
status request is also the sign of life, see `info.lastContact`) and every 10 minutes while the server cannot
be reached. The server alarms (mail) after 2 hours without contact; a monitoring script in the ioBroker should
alarm after 1 hour. The tab **Data flow** in the instance settings lists which Solar-Log data points are
delivered as which values.

## Sources

### Journal of iobroker.solarlog

The solarlog adapter computes the split itself (including the intraday-integrated method) and writes the
result of every night into the state `Database.dailyJournal` (a JSON list of `{ date, meterRows, buildingRow }`).
This adapter imports that state and delivers it. The state to read is configurable
(default `solarlog.0.Database.dailyJournal`).

### Energy states of other adapters

For properties without a device that keeps the books itself, for example one Shelly energy meter per apartment
and the inverter of a PV system (goodwe-sems, solinteg, ...). In the configuration you list

- **Units**: name as it appears in the billing (`WHG 1`) and the energy state of its meter,
- **Own production**: energy states of all inverters (summed),
- **Feed-in** (optional): energy states of the feed-in meter.

Each state is either a *counter* (rises continuously, the day's value is the difference to the reading of the
day before) or a *day value* (resets at midnight, read at the closing time). Units may be Wh or kWh.

At the closing time (default 23:58) the day is closed:

```
self-consumed = production - feed-in          (with a feed-in meter)
              = min(production, consumption)  (without)
share         = min(1, self-consumed / total consumption of all units)
solar(unit)   = consumption(unit) * share
grid(unit)    = consumption(unit) - solar(unit)
```

This is the proportional method: every unit gets the same share of own production, so solar plus grid is
always exactly the consumption of the unit. Notes:

- The first run only stores the starting readings; the first day record follows the next day.
- A counter that went backwards is taken as reset or replaced.
- If the last reading is older than yesterday (adapter stopped), the days in between cannot be reconstructed
  from counters and are skipped; a warning is logged.
- A reading older than the configured maximum age marks the day as `veraltet`.
- This source uses the method `tagesnetto` (day balance). The integrated method needs measurements every
  few seconds and is only available with the solarlog journal.

## Configuration

| Setting | Meaning |
|---|---|
| Server | host name only, e.g. `abr.bronnenhuber.ch`; the connection is always HTTPS (plain HTTP is accepted for localhost only) |
| API path | `/api/v1`, normally not changed |
| API token | `abrk_...`, created per client in the Administration area of the web application (Clients, tab Access), shown once, can be revoked; stored encrypted |
| Source | journal of iobroker.solarlog, or energy states |
| Units of the journal | optional table: rename a unit of the solarlog journal for the billing, or leave it out |

The button *Test connection* checks server and token (also the already saved one) and shows the name of the client.

## Security

- The token belongs to exactly one client; the server derives the client from the token, never from the payload.
- The server stores only a hash of the token. A token can expire, be bound to addresses and be revoked at any time.
- The adapter never follows redirects, refuses non-HTTPS servers (except localhost) and uses a 30 s timeout.
- The token is stored in the encrypted part of the instance configuration and is never written to the log.

## States

| State | Meaning |
|---|---|
| `info.connection` | server reachable and token accepted |
| `info.lastDelivery`, `info.lastDeliveredDate` | time of the last accepted delivery and the newest day in it |
| `info.pendingDays` | days still missing on the server after the last run |
| `info.lastError`, `info.rejectedDates` | last problem; days the server refused for their content |
| `data.journal` | local journal of the day records |
| `control.syncNow` | deliver now |
| `control.closeDayNow` | close today now (source energy states) |

## API contract

`GET /api/v1/status.php` returns the units of the client, the days the server holds
(`present_meter_dates`, `present_building_dates`, last 120 days) and the tariffs. The adapter takes the tariff
of the month from there and computes `total_chf` from the rounded kWh, so the stored total can be recomputed
from the stored row.

`POST /api/v1/ingest.php` takes

```json
{
  "schema": 1,
  "source": "iobroker-solarlog",
  "adapter_version": "0.1.3",
  "meter_daily": [
    { "date": "2026-10-24", "meter": "WHG 1", "verbrauch_kwh": 10.5, "solarbezug_kwh": 4.0, "netzbezug_kwh": 6.5,
      "tarif_netz": 0.28, "tarif_solar": 0.20, "total_chf": 2.92, "methode": "integriert", "quality": "ok" }
  ],
  "building_daily": [
    { "date": "2026-10-24", "produktion_kwh": 30, "verbrauch_kwh": 40, "einspeisung_kwh": 5, "autarkiegrad": 0.625 }
  ]
}
```

and answers 200 (stored, idempotent), 401 (token), 422 (content refused, nothing stored), 429/5xx (retry later).
A refused day is isolated: the other days of the same run are still delivered.

## Development

```
npm install
npm test                  # unit tests and package checks
npm run test:integration  # starts a real js-controller with a fake server
npm run lint
npm run check             # type check
```

## Changelog

### 0.1.3

- Status request every 10 minutes as sign of life, new state `info.lastContact`. New tab Data flow.

### 0.1.2

- Fix: button Test connection (messagebox).

### 0.1.0

- Initial release: delivery of the solarlog journal and of energy states to the Abrechnung Mailcarrier API.

## License

MIT License, Copyright (c) 2026 Stefan Bühler
