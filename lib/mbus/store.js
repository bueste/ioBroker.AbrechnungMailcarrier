"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** Maximum number of undelivered batches kept on disk (about a year of 15 minute polls for one Moxa). */
const MAX_PENDING = 40000;

/**
 * Local storage of the M-Bus module on the disk of the ioBroker host:
 *  - archive/mbus-YYYY-MM.jsonl   every reading ever taken (kept, for auditing and for re-delivery)
 *  - pending.jsonl                batches not yet accepted by the server (survive a restart or an outage)
 *  - rejected.jsonl               batches the server refused for good (for inspection)
 *  - state.json                   small bookkeeping (commands done, last runs)
 */
class Store {
    /** @param {string} dir */
    constructor(dir) {
        this.dir = dir;
        this.archiveDir = path.join(dir, "archive");
        this.pendingFile = path.join(dir, "pending.jsonl");
        this.rejectedFile = path.join(dir, "rejected.jsonl");
        this.stateFile = path.join(dir, "state.json");
        /** @type {object[]} */
        this.pending = [];
        this.state = { commands: {}, lastRun: {} };
    }

    init() {
        fs.mkdirSync(this.archiveDir, { recursive: true });
        this.pending = readLines(this.pendingFile);
        try {
            this.state = {
                commands: {},
                lastRun: {},
                ...JSON.parse(fs.readFileSync(this.stateFile, "utf8")),
            };
        } catch {
            // first start or damaged file: begin empty
        }
    }

    /**
     * @param {object[]} rows @param {Date} [when]
     * @param when
     */
    archive(rows, when = new Date()) {
        if (rows.length === 0) {
            return;
        }
        const name = `mbus-${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}.jsonl`;
        fs.appendFileSync(
            path.join(this.archiveDir, name),
            `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
        );
    }

    /** @param {object} batch */
    enqueue(batch) {
        this.pending.push(batch);
        let dropped = 0;
        while (this.pending.length > MAX_PENDING) {
            this.pending.shift();
            dropped++;
        }
        if (dropped > 0) {
            this.writePending();
        } else {
            fs.appendFileSync(this.pendingFile, `${JSON.stringify(batch)}\n`);
        }
        return dropped;
    }

    /**
     * Removes the first n batches (delivered or refused). @param {number} n
     *
     * @param n
     */
    shift(n = 1) {
        this.pending.splice(0, n);
        this.writePending();
    }

    /**
     * @param {object} batch @param {string} reason
     * @param reason
     */
    reject(batch, reason) {
        fs.appendFileSync(
            this.rejectedFile,
            `${JSON.stringify({
                at: new Date().toISOString(),
                reason,
                batch,
            })}\n`,
        );
    }

    writePending() {
        writeAtomic(
            this.pendingFile,
            this.pending.map((b) => JSON.stringify(b)).join("\n") +
                (this.pending.length ? "\n" : ""),
        );
    }

    saveState() {
        writeAtomic(this.stateFile, JSON.stringify(this.state));
    }
}

/** @param {string} file @returns {object[]} */
function readLines(file) {
    let text = "";
    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        return [];
    }
    const out = [];
    for (const line of text.split("\n")) {
        if (!line.trim()) {
            continue;
        }
        try {
            out.push(JSON.parse(line));
        } catch {
            // a half written last line after a crash: skip it
        }
    }
    return out;
}

/**
 * @param {string} file @param {string} content
 * @param content
 */
function writeAtomic(file, content) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
}

module.exports = { Store, MAX_PENDING };
