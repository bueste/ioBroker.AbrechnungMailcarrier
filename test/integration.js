const http = require("node:http");
const path = require("node:path");
const { tests } = require("@iobroker/testing");

// Runs a real js-controller with this adapter. A small local server plays the web application, so the whole
// path is covered: journal state of the solarlog adapter -> own journal -> status call -> delivery -> info states.

const JOURNAL_ID = "solarlog.0.Database.dailyJournal";

function journal() {
    const today = new Date();
    const date = (back) => {
        const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    return [3, 2, 1].map((back) => ({
        date: date(back),
        meterRows: [
            {
                reading_date: date(back),
                meter_name: "WHG 1",
                zaehlerstand_start_kwh: 100,
                zaehlerstand_ende_kwh: 110,
                verbrauch_kwh: 10,
                solarbezug_kwh: 4,
                netzbezug_kwh: 6,
                tarif_netz: 0.28,
                tarif_solar: 0.2,
                total_chf: 2.8,
                berechnungsmethode: "integriert",
            },
        ],
        buildingRow: {
            reading_date: date(back),
            produktion_kwh: 20,
            verbrauch_kwh: 40,
            einspeisung_kwh: 0,
            eigenverbrauchsquote: 0.5,
            berechnungsmethode: "integriert",
        },
    }));
}

function startFakeApi() {
    return new Promise((resolve) => {
        const received = [];
        const server = http.createServer((req, res) => {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                res.setHeader("Content-Type", "application/json");
                if (req.headers.authorization !== "Bearer abrk_testtoken") {
                    res.statusCode = 401;
                    res.end(JSON.stringify({ ok: false, error: "unauthorized", message: "Token ungültig" }));
                    return;
                }
                if (req.method === "GET") {
                    res.end(
                        JSON.stringify({
                            ok: true,
                            client: { name: "Testmandant", max_units: 8 },
                            units: [],
                            tariffs: [{ year: new Date().getFullYear(), month: new Date().getMonth() + 1, netz_chf_kwh: 0.3, solar_chf_kwh: 0.15 }],
                            present_meter_dates: {},
                            present_building_dates: [],
                        }),
                    );
                    return;
                }
                received.push(JSON.parse(body));
                res.end(JSON.stringify({ ok: true, inserted: 1, updated: 0, unchanged: 0 }));
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ server, received, port: server.address().port }));
    });
}

tests.integration(path.join(__dirname, ".."), {
    defineAdditionalTests({ suite }) {
        suite("Adapter startup without configuration", (getHarness) => {
            it("should start and stay alive although the API is not configured", async function () {
                this.timeout(60000);
                const harness = getHarness();
                await harness.startAdapterAndWait();
                if (!harness.isAdapterRunning()) {
                    throw new Error("Adapter process is not running after startup");
                }
            });
        });

        suite("Delivery of the solarlog journal", (getHarness) => {
            let api;

            before(async () => {
                api = await startFakeApi();
            });

            after(() => new Promise((resolve) => api.server.close(resolve)));

            it("delivers the journal days with the server's tariff and reports the result in the info states", async function () {
                this.timeout(120000);
                const harness = getHarness();
                await harness.changeAdapterConfig("abrechnungmailcarrier", {
                    native: {
                        apiUrl: `http://127.0.0.1:${api.port}/api/v1`,
                        apiToken: "abrk_testtoken",
                        sourceType: "solarlogJournal",
                        journalStateId: JOURNAL_ID,
                    },
                });
                await new Promise((resolve, reject) => {
                    harness.states.setState(JOURNAL_ID, { val: JSON.stringify(journal()), ack: true }, (err) => (err ? reject(err) : resolve()));
                });
                await harness.startAdapterAndWait();

                // the adapter delivers 10 s after the start
                const deadline = Date.now() + 60000;
                while (api.received.length === 0 && Date.now() < deadline) {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }
                if (api.received.length === 0) {
                    throw new Error("The fake server received no delivery");
                }
                const payload = api.received[0];
                if (payload.schema !== 1 || payload.meter_daily.length !== 3 || payload.building_daily.length !== 3) {
                    throw new Error(`Unexpected payload: ${JSON.stringify(payload)}`);
                }
                const row = payload.meter_daily[0];
                // 4 kWh solar * 0.15 + 6 kWh grid * 0.30 = 2.40 with the tariff of the server, not the 2.80 of the journal
                if (row.tarif_netz !== 0.3 || row.tarif_solar !== 0.15 || row.total_chf !== 2.4) {
                    throw new Error(`Tariff of the server not applied: ${JSON.stringify(row)}`);
                }

                const state = async (id) => harness.states.getStateAsync(`abrechnungmailcarrier.0.${id}`);
                const waitFor = async (id, test) => {
                    for (let i = 0; i < 40; i++) {
                        const st = await state(id);
                        if (st && test(st.val)) {
                            return st.val;
                        }
                        await new Promise((resolve) => setTimeout(resolve, 250));
                    }
                    throw new Error(`State ${id} did not reach the expected value`);
                };
                await waitFor("info.connection", (v) => v === true);
                await waitFor("info.pendingDays", (v) => v === 0);
                await waitFor("info.lastDeliveredDate", (v) => typeof v === "string" && v.length === 10);
            });
        });
    },
});
