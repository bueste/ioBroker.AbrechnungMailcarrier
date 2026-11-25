"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/**
 * SSH to a MikroTik router with the system's OpenSSH client (no extra npm package). Key login only: the key pair
 * belongs to the adapter and lives in its data folder, the public key is shown in the web application so it can be
 * imported on the routers once. The host key is remembered at the first contact and must match afterwards.
 */

/** @param {string} dir */
function keyFile(dir) {
    return path.join(dir, "ssh", "id_ed25519");
}

/**
 * Creates the key pair if it does not exist yet.
 *
 * @param {string} dir adapter data folder
 * @returns {Promise<{ ok: boolean, publicKey?: string, error?: string }>}
 */
async function ensureKey(dir) {
    const f = keyFile(dir);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(f)) {
        const r = await run(
            "ssh-keygen",
            [
                "-q",
                "-t",
                "ed25519",
                "-N",
                "",
                "-C",
                "iobroker-abrechnungmailcarrier",
                "-f",
                f,
            ],
            20000,
        );
        if (r.code !== 0) {
            return {
                ok: false,
                error: `ssh-keygen: ${r.err || r.out || "fehlgeschlagen"}`,
            };
        }
    }
    try {
        return {
            ok: true,
            publicKey: fs.readFileSync(`${f}.pub`, "utf8").trim(),
        };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<{ code: number|null, out: string, err: string }>}
 */
function run(cmd, args, timeoutMs) {
    return new Promise((resolve) => {
        let out = "";
        let err = "";
        let done = false;
        let p;
        try {
            p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
        } catch (e) {
            resolve({ code: null, out: "", err: e.message });
            return;
        }
        const finish = (code) => {
            if (!done) {
                done = true;
                clearTimeout(t);
                resolve({ code, out, err });
            }
        };
        const t = setTimeout(() => {
            p.kill("SIGKILL");
            err += `\nZeitüberschreitung nach ${timeoutMs} ms`;
            finish(null);
        }, timeoutMs);
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (err += d));
        p.on("error", (e) => {
            err += e.message;
            finish(null);
        });
        p.on("close", (c) => finish(c));
    });
}

/**
 * @param {{ host: string, port?: number, ssh_user?: string, user?: string }} router
 * @param {string} dir adapter data folder
 * @returns {(command: string, timeoutMs?: number) => Promise<{ code: number|null, out: string, err: string }>}
 */
function makeExec(router, dir) {
    const base = [
        "-i",
        keyFile(dir),
        "-p",
        String(router.port || 22),
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        `UserKnownHostsFile=${path.join(dir, "ssh", "known_hosts")}`,
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=10",
        "-o",
        "ServerAliveCountMax=3",
    ];
    const user = router.ssh_user || router.user || "admin";
    return async (command, timeoutMs = 60000) => {
        const r = await run(
            "ssh",
            [...base, `${user}@${router.host}`, command],
            timeoutMs,
        );
        return {
            code: r.code,
            out: r.out.replace(/\r/g, ""),
            err: r.err.replace(/\r/g, ""),
        };
    };
}

/**
 * Copies a file from the router (best effort, for the backup before an update).
 *
 * @param {{ host: string, port?: number, ssh_user?: string }} router
 * @param {string} dir
 * @param {string} remote
 * @param {string} local
 */
async function fetchFile(router, dir, remote, local) {
    const user = router.ssh_user || "admin";
    fs.mkdirSync(path.dirname(local), { recursive: true });
    const r = await run(
        "scp",
        [
            "-i",
            keyFile(dir),
            "-P",
            String(router.port || 22),
            "-o",
            "BatchMode=yes",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            `UserKnownHostsFile=${path.join(dir, "ssh", "known_hosts")}`,
            "-o",
            "ConnectTimeout=10",
            `${user}@${router.host}:${remote}`,
            local,
        ],
        120000,
    );
    return r.code === 0;
}

module.exports = { ensureKey, makeExec, fetchFile, keyFile, run };
