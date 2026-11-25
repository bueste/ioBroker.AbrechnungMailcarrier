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
Since solarlog 3.1.0 the current day is also written every 15 minutes with `datenqualitaet = vorlaeufig`; the
night replaces it. This adapter imports that state and delivers it, so the server holds the state of the day
so far (quality `vorlaeufig`) even if the ioBroker fails before the night. If the night never happens, the
day stays `vorlaeufig` on the server and raises its alarm. The state to read is configurable
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
| Server | host name only, e.g. `abr.mailcarrier.ch`; the connection is always HTTPS (plain HTTP is accepted for localhost only) |
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

## M-Bus meter reading (since 0.2.0)

Reads cold/hot water and heat meters (M-Bus, EN 13757) through a Moxa NPort in **TCP server mode, raw**
(2400 baud, 8E1, set in the Moxa) and delivers the readings to the web application. Enable it on the tab
*M-Bus meters* and enter one API token per site (client), up to four. The server and API path are those of the
Connection tab; the solar delivery above is optional and independent.

What lives where:

- **Web application** (leading): the Moxa addresses, the three intervals, the assignment of meters to apartments
  and the alarms. It also queues commands (test the connection, scan the bus, set the clock).
- **Adapter**: fetches that configuration every minute, reads the expected meters on the quarter-hour grid
  (default every 15 minutes), scans the bus 0 to 250 when due (default every 30 days) and runs the commands.
- **Disk** of the ioBroker host (instance data folder): `archive/mbus-YYYY-MM.jsonl` keeps every reading,
  `pending.jsonl` holds the packages not yet accepted by the server (survives a restart and an outage, delivered in
  order), `rejected.jsonl` the ones the server refused for good.

States (per site `a1` .. `a4`):

| State | Meaning |
|---|---|
| `mbus.a1.units.<unit>.<kind>.value / unit / value2 / meterId / lastRead` | reading of an assigned meter (kinds: kaltwasser, warmwasser, waerme); heat: kWh and volume as value2 |
| `mbus.a1.unassigned.<meterId>.*` | meters not yet assigned to an apartment |
| `mbus.a1.gateways.<id>.reachable / lastPoll / lastError` | state of each Moxa |
| `mbus.a1.settings.readMinutes / scanDays / timesyncDays / timesyncEnabled` | intervals, writable: a change is sent to the server (refused if somebody changed it there meanwhile) |
| `mbus.a1.alarms.count / text` | open warnings and critical findings of the server, for your own notification script |
| `mbus.a1.info.pending` | packages waiting for delivery |

The telegram parser (`lib/mbus/parse.js`) is verified against real telegrams of the installed meters (RKE heat meters,
IST water meters). Setting the clock of a meter (command *timesync*) is only reported as successful if the meter
clock really changed afterwards.

### Tables in the instance configuration (since 0.3.0)

Moxas, apartments and routers can be entered in the tab "M-Bus Zähler" as well as in the web application. The
column "Anlage" (a1 to a4) tells which token (client) a row belongs to. The adapter compares the tables with the
web application every minute, using the state both sides agreed on last time (`state.json`, `cfgSnap`):

- a row changed or added here goes to the web application (`config_push` in the delivery, answered with `config_result`);
- a row changed in the web application and not here is taken over into the table;
- a row removed here is deleted there (an empty table is never taken as "delete everything"; apartments with assigned meters are refused);
- a row the web application refuses stays in the table and is reported once per hour in the log.

When the tables change, the adapter writes them into its own configuration, which restarts the instance once.

**Automatic COM port.** For every active Moxa with a network address the adapter mounts a virtual COM port (pseudo terminal through `socat`) in the data folder of the instance, e.g. `com/a1-moxa-21`. The path is shown in the table (column "COM-Port") and in the state `mbus.<a1..a4>.gateways.<id>.comPort`. The port is unmounted when the Moxa is unreachable, disabled or deleted and when the adapter stops, and mounted again by itself. The readings use this port while it is mounted, otherwise the TCP connection directly. The web console password is entered per Moxa in its table row (encrypted, never sent to the server).

**Meters.** The table "Zähler und Zuteilung" lists the meters found by the bus scan. Kind, apartment, label and status can be changed here and in the web application and are compared like the other tables.

**COM device instead of TCP.** A Moxa in real-COM mode (driver maps it to e.g. `/dev/ttyr00`) or a USB serial
adapter (`/dev/ttyUSB0`) can be used by entering the device in the column "COM-Gerät". The adapter opens it with
`socat` (`sudo apt install socat`), 2400 baud 8E1 unless set otherwise in the web application. The user of the
instance needs access to the device (group `dialout`). Firmware care needs a network address and is skipped for
a COM device.

### Moxa firmware care

With the Moxa web password in the M-Bus tab the adapter looks after the firmware of the serial servers: weekly check
(model and version from the web console, newest version from moxa.com with its SHA-512), flashing only at night
(01:00 to 02:45) and only if the web application allows it for that Moxa, then a check that the device is back
with the new version and an open serial port. A failure raises a critical finding and the adapter tries again only
after a week. Pages like restart, reset or logout are never requested. The state per Moxa is in
`mbus.a1.gateways.<id>.moxaModel / moxaFirmware / moxaFirmwareStatus`.

### MikroTik router updates

The adapter keeps its own SSH key pair in the data folder (`ssh/id_ed25519`) and reports the public key to the web
application, which shows how to import it on a router. The routers, their update channel and the update time (weekdays,
start time, window) are set in the web application. The adapter looks at the routers daily and, inside the window,
installs RouterOS (and on request the RouterBOARD firmware) after a backup, and verifies that the router is back with
the new version. States: `mbus.a1.routers.<id>.version / latest / status`. Needs the OpenSSH client (`ssh`, `scp`,
`ssh-keygen`) on the host.

## Development

```
npm install
npm test                  # unit tests and package checks
npm run test:integration  # starts a real js-controller with a fake server
npm run lint
npm run check             # type check
```

## Changelog

### 0.3.5

- bus scan: 150 ms pause after every answer (the Relay master ignored the next telegram, meters 2, 4, 6 were overlooked)

### 0.3.4

- info.connection follows the M-Bus side (web application and active Moxas answer)
- first scan right after the Moxa setup

### 0.3.3

- Moxa setup through the web console (TCP server mode, raw, serial line of the site), switch in the table
- intervals per site as table, two-way
- COM port path /opt/iobroker/com/<a1..a4>-moxa-<id>, finding `com_port` when not mounted

### 0.3.2

- Moxa web console parsed correctly (values are set by script on the overview page), operating mode and serial settings read
- button Status in the tab Moxa and routers

### 0.3.1

- automatic mount/unmount of a virtual COM port per Moxa, shown in the table
- Moxa web password per box (replaces the one password for all)
- table for meters and their assignment, two-way with the web application
- own tab for Moxa and routers

### 0.3.0

- Moxas, apartments and routers can be entered in the instance configuration; two-way comparison with the web application
- COM device as connection of a Moxa

### 0.2.0

- New: M-Bus meter reading through a Moxa serial server, local archive, delivery with retry, configuration and alarms from the web application. The solar delivery is optional.

### 0.1.4

- Delivers the provisional state of the current day (`vorlaeufig`, every 15 minutes with solarlog 3.1.0). Needs the web application with quality `vorlaeufig`.

### 0.1.3

- Status request every 10 minutes as sign of life, new state `info.lastContact`. New tab Data flow.

### 0.1.2

- Fix: button Test connection (messagebox).

### 0.1.0

- Initial release: delivery of the solarlog journal and of energy states to the Abrechnung Mailcarrier API.

## License

MIT License, Copyright (c) 2026 Stefan Bühler
