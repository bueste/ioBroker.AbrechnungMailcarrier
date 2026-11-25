"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const RESTART_AFTER_MS = 15000;
const UP_AFTER_MS = 800;

/**
 * Keeps one virtual COM port (pseudo terminal) per Moxa: socat connects to the serial server (TCP, raw) and
 * offers the stream as a device file. The port appears when the Moxa is reachable and disappears when it is not,
 * when the Moxa is switched off or removed in the configuration, and when the adapter stops. Mount, unmount and
 * reconnect need no manual step.
 *
 * The device files live in the data directory of the instance (the ioBroker user may create them there, /dev is
 * root only), e.g. .../abrechnungmailcarrier.0/com/a1-moxa-21.
 */
class ComMounts {
    /**
     * @param {object} o
     * @param {{ info: Function, warn: Function, error: Function, debug: Function }} o.log
     * @param {string} o.dir data directory of the instance
     * @param {(label: string, id: number, path: string) => void} [o.onChange] called when a port appears or disappears
     * @param {(file: string, host: string, port: number) => { cmd: string, args: string[] }} [o.command] the helper call (tests replace it)
     * @param {number} [o.restartMs]
     * @param {number} [o.upAfterMs]
     */
    constructor(o) {
        this.log = o.log;
        this.dir = path.join(o.dir, "com");
        this.onChange = o.onChange || (() => {});
        this.command = o.command || socatMount;
        this.restartMs = o.restartMs || RESTART_AFTER_MS;
        this.upAfterMs = o.upAfterMs || UP_AFTER_MS;
        /** @type {Map<string, { label: string, id: number, host: string, port: number, child: any, up: boolean, timer: any, upTimer: any, wanted: boolean, lastErr: string, logged: string }>} */
        this.ports = new Map();
        this.stopped = false;
        fs.mkdirSync(this.dir, { recursive: true });
        this.cleanStale();
    }

    /**
     * @param {string} label @param {number} id
     * @param id
     */
    file(label, id) {
        return path.join(this.dir, `${label}-moxa-${id}`);
    }

    /**
     * @param {string} label @param {number} id
     * @param id
     */
    isUp(label, id) {
        const p = this.ports.get(`${label}:${id}`);
        return !!(p && p.up);
    }

    /** Removes what a previous run left behind (a socat that outlived a killed adapter, stale links). */
    cleanStale() {
        for (const name of fs.readdirSync(this.dir)) {
            const full = path.join(this.dir, name);
            if (name.endsWith(".pid")) {
                const pid = Number(fs.readFileSync(full, "utf8"));
                try {
                    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
                    if (pid > 1 && cmd.includes("socat")) {
                        process.kill(pid);
                    }
                } catch {
                    // not running any more
                }
            }
            try {
                fs.rmSync(full, { force: true });
            } catch {
                // ignore
            }
        }
    }

    /**
     * Brings the ports of one client in line with its Moxa list.
     *
     * @param {string} label client label (a1 .. a4)
     * @param {{ id: number, host?: string, port?: number, enabled?: boolean, device?: string|null }[]} gateways
     */
    sync(label, gateways) {
        if (this.stopped) {
            return;
        }
        const want = new Map();
        for (const g of gateways) {
            if (g.enabled !== false && g.host && !g.device) {
                want.set(`${label}:${g.id}`, g);
            }
        }
        for (const [key, p] of this.ports) {
            if (p.label !== label) {
                continue;
            }
            const g = want.get(key);
            if (!g || g.host !== p.host || Number(g.port) !== p.port) {
                this.unmount(key);
            }
        }
        for (const [key, g] of want) {
            if (!this.ports.has(key)) {
                this.mount(key, label, g);
            }
        }
    }

    /**
     * @param {string} key @param {string} label @param {any} g
     * @param label
     * @param g
     */
    mount(key, label, g) {
        const entry = {
            label,
            id: Number(g.id),
            host: String(g.host),
            port: Number(g.port) || 4001,
            child: null,
            up: false,
            timer: null,
            upTimer: null,
            wanted: true,
            lastErr: "",
            logged: "",
        };
        this.ports.set(key, entry);
        this.launch(entry);
    }

    /** @param {any} p */
    launch(p) {
        if (this.stopped || !p.wanted) {
            return;
        }
        const file = this.file(p.label, p.id);
        const { cmd, args } = this.command(file, p.host, p.port);
        let child;
        try {
            child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
        } catch (e) {
            this.failed(p, /** @type {Error} */ (e).message);
            return;
        }
        p.child = child;
        try {
            fs.writeFileSync(`${file}.pid`, String(child.pid));
        } catch {
            // the pid file only helps the cleanup after a crash
        }
        child.stderr.on("data", (/** @type {Buffer} */ d) => {
            const line = d.toString().trim().split("\n").pop();
            if (line) {
                p.lastErr = line.slice(-200);
            }
        });
        child.on("error", (e) =>
            this.failed(
                p,
                /** @type {any} */ (e).code === "ENOENT"
                    ? "socat fehlt (sudo apt install socat)"
                    : e.message,
            ),
        );
        child.on("exit", (code) => {
            if (p.child !== child) {
                return;
            }
            p.child = null;
            this.setUp(p, false);
            clearTimeout(p.upTimer);
            this.rm(file);
            if (p.wanted && !this.stopped) {
                this.failed(p, p.lastErr || `socat beendet (Code ${code})`);
            }
        });
        p.upTimer = setTimeout(() => {
            if (p.child === child && fs.existsSync(file)) {
                this.setUp(p, true);
            }
        }, this.upAfterMs);
    }

    /**
     * @param {any} p @param {string} msg
     * @param msg
     */
    failed(p, msg) {
        const text = `COM-Port ${p.label} Moxa ${p.id} (${p.host}:${p.port}) nicht eingebunden: ${msg}`;
        if (p.logged !== msg) {
            p.logged = msg;
            this.log.warn(text);
        }
        clearTimeout(p.timer);
        p.timer = setTimeout(() => this.launch(p), this.restartMs);
    }

    /**
     * @param {any} p @param {boolean} up
     * @param up
     */
    setUp(p, up) {
        if (p.up === up) {
            return;
        }
        p.up = up;
        if (up) {
            this.log.info(
                `COM-Port ${p.label} Moxa ${p.id}: ${this.file(p.label, p.id)} eingebunden (${p.host}:${p.port})`,
            );
            p.logged = "";
        } else {
            this.log.info(`COM-Port ${p.label} Moxa ${p.id}: ausgehängt`);
        }
        this.onChange(p.label, p.id, up ? this.file(p.label, p.id) : "");
    }

    /** @param {string} key */
    unmount(key) {
        const p = this.ports.get(key);
        if (!p) {
            return;
        }
        p.wanted = false;
        clearTimeout(p.timer);
        clearTimeout(p.upTimer);
        const child = p.child;
        p.child = null;
        if (child) {
            child.kill();
        }
        this.setUp(p, false);
        this.rm(this.file(p.label, p.id));
        this.ports.delete(key);
    }

    /** @param {string} file */
    rm(file) {
        for (const f of [file, `${file}.pid`]) {
            try {
                fs.rmSync(f, { force: true });
            } catch {
                // ignore
            }
        }
    }

    /** Unmounts everything (adapter stops). */
    stopAll() {
        this.stopped = true;
        for (const key of [...this.ports.keys()]) {
            this.unmount(key);
        }
    }
}

/**
 * socat call: pseudo terminal with a link at `file` on one side, TCP connection to the serial server on the other.
 *
 * @param {string} file
 * @param {string} host
 * @param {number} port
 */
function socatMount(file, host, port) {
    return {
        cmd: "socat",
        args: [
            `pty,link=${file},raw,echo=0,mode=660`,
            `tcp:${host}:${port},nodelay,keepalive,connect-timeout=5`,
        ],
    };
}

module.exports = { ComMounts, socatMount };
