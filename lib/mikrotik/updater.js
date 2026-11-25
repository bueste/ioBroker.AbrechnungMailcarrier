"use strict";

const path = require("node:path");
const ros = require("./routeros");
const sshTools = require("./ssh");

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Keeps MikroTik routers up to date: RouterOS (on the channel set for the router) and, if wanted, the RouterBOARD
 * firmware. Each step is checked: the router must come back, with the new version.
 */
class RouterUpdater {
    /**
     * @param {object} o
     * @param {{ info: Function, warn: Function, error: Function, debug: Function }} o.log
     * @param {string} o.dir adapter data folder (ssh key, backups)
     * @param {(router: any) => ros.Exec} [o.execFor]
     * @param {(router: any, remote: string, local: string) => Promise<boolean>} [o.fetchFile]
     * @param {(ms: number) => Promise<void>} [o.sleep]
     * @param {() => number} [o.now]
     * @param {number} [o.settleMs]       pause after the install command, the router is busy downloading and rebooting
     * @param {number} [o.rebootTimeoutMs] how long a reboot may take
     * @param {number} [o.pollMs]
     */
    constructor(o) {
        this.log = o.log;
        this.dir = o.dir;
        this.execFor =
            o.execFor || ((router) => sshTools.makeExec(router, o.dir));
        this.fetchFile =
            o.fetchFile ||
            ((router, remote, local) =>
                sshTools.fetchFile(router, o.dir, remote, local));
        this.sleep = o.sleep || sleep;
        this.now = o.now || Date.now;
        this.settleMs = o.settleMs ?? 60000;
        this.rebootTimeoutMs = o.rebootTimeoutMs ?? 15 * 60000;
        this.pollMs = o.pollMs ?? 10000;
    }

    /**
     * Looks at the router: version, newest version, RouterBOARD firmware. Changes nothing except the update channel.
     *
     * @param {any} router
     * @returns {Promise<{ status: "aktuell"|"veraltet"|"fehler", reachable: boolean, note: string, version?: string, latest?: string|null, board?: string, model?: string, identity?: string, rbCurrent?: string|null, rbUpgrade?: string|null, osNewer?: boolean, rbNewer?: boolean }>}
     */
    async check(router) {
        const exec = this.execFor(router);
        const info = await ros.readInfo(exec);
        if (!info.ok || !info.version) {
            return {
                status: "fehler",
                reachable: false,
                note: `Router nicht lesbar: ${info.error}`,
            };
        }
        const upd = await ros.checkUpdate(exec, router.channel || "stable");
        const rbNewer = !!(
            router.routerboard_fw &&
            info.routerboard &&
            info.rbCurrent &&
            info.rbUpgrade &&
            ros.compareVersions(info.rbUpgrade, info.rbCurrent) > 0
        );
        const base = {
            reachable: true,
            version: info.version,
            board: info.board,
            model: info.model,
            identity: info.identity,
            rbCurrent: info.rbCurrent,
            rbUpgrade: info.rbUpgrade,
        };
        if (!upd.ok) {
            return {
                ...base,
                status: "fehler",
                note: `RouterOS ${info.version}: ${upd.error}`,
                rbNewer,
            };
        }
        const osNewer = !!upd.newer;
        const parts = [];
        parts.push(
            osNewer
                ? `RouterOS ${info.version}, neu ist ${upd.latest} (${router.channel || "stable"})`
                : `RouterOS ${info.version} ist aktuell (${router.channel || "stable"})`,
        );
        if (rbNewer) {
            parts.push(
                `RouterBOARD-Firmware ${info.rbCurrent}, neu ist ${info.rbUpgrade}`,
            );
        }
        return {
            ...base,
            status: osNewer || rbNewer ? "veraltet" : "aktuell",
            latest: upd.latest,
            osNewer,
            rbNewer,
            note: `${parts.join("; ")}.`,
        };
    }

    /**
     * Installs what is available and verifies the router afterwards.
     *
     * @param {any} router
     * @returns {Promise<{ ok: boolean, status: string, note: string, from?: string, to?: string }>}
     */
    async update(router) {
        const exec = this.execFor(router);
        const c = await this.check(router);
        if (c.status === "fehler") {
            return { ok: false, status: "fehler", note: c.note };
        }
        if (c.status === "aktuell") {
            return {
                ok: true,
                status: "aktuell",
                note: c.note,
                from: c.version,
                to: c.version,
            };
        }
        const from = /** @type {string} */ (c.version);
        let to = from;
        const notes = [];

        // backup first, kept on the router and (best effort) on this host
        const stamp = new Date(this.now()).toISOString().slice(0, 10);
        const name = `iob-pre-update-${stamp}`;
        try {
            await exec(`/system backup save name=${name}`);
            await exec(`/export file=${name}`);
            const okB = await this.fetchFile(
                router,
                `${name}.backup`,
                path.join(
                    this.dir,
                    "router-backup",
                    `${router.host}-${stamp}.backup`,
                ),
            );
            const okR = await this.fetchFile(
                router,
                `${name}.rsc`,
                path.join(
                    this.dir,
                    "router-backup",
                    `${router.host}-${stamp}.rsc`,
                ),
            );
            notes.push(
                okB || okR
                    ? "Sicherung auf dem Pi"
                    : "Sicherung nur auf dem Router",
            );
        } catch (e) {
            notes.push(`Sicherung nicht möglich (${e.message})`);
        }

        if (c.osNewer && c.latest) {
            this.log.info(
                `Router ${router.name || router.host}: RouterOS ${from} -> ${c.latest} wird installiert`,
            );
            await exec("/system package update install", 30000); // the router downloads, installs and reboots: the connection ends
            const back = await this.waitFor(
                exec,
                (i) => i.version === c.latest,
            );
            if (!back.ok) {
                return {
                    ok: false,
                    status: "fehler",
                    from,
                    note: `${back.note} (erwartet RouterOS ${c.latest}). ${notes.join(", ")}`,
                };
            }
            to = c.latest;
            notes.push(`RouterOS ${from} -> ${to}`);
        }

        // RouterBOARD firmware: takes effect with one more reboot
        const after = await ros.readInfo(exec);
        if (
            router.routerboard_fw &&
            after.ok &&
            after.routerboard &&
            after.rbCurrent &&
            after.rbUpgrade &&
            ros.compareVersions(after.rbUpgrade, after.rbCurrent) > 0
        ) {
            this.log.info(
                `Router ${router.name || router.host}: RouterBOARD-Firmware ${after.rbCurrent} -> ${after.rbUpgrade}`,
            );
            await exec("/system routerboard upgrade", 60000);
            const r = await exec("/system reboot", 15000);
            if (/\[y\/N\]|yes\?/i.test(r.out)) {
                await exec(':execute "/system reboot"', 15000);
            }
            const want = after.rbUpgrade;
            const back = await this.waitFor(exec, (i) => i.rbCurrent === want);
            if (!back.ok) {
                return {
                    ok: false,
                    status: "fehler",
                    from,
                    to,
                    note: `${back.note} (RouterBOARD-Firmware ${want} erwartet). ${notes.join(", ")}`,
                };
            }
            notes.push(`RouterBOARD-Firmware ${after.rbCurrent} -> ${want}`);
        }
        return {
            ok: true,
            status: "aktuell",
            from,
            to,
            note: `${notes.join(", ")}. Router ist wieder erreichbar.`,
        };
    }

    /**
     * Waits until the router answers and the condition holds.
     *
     * @param {ros.Exec} exec
     * @param {(i: Awaited<ReturnType<typeof ros.readInfo>>) => boolean} cond
     * @returns {Promise<{ ok: boolean, note: string }>}
     */
    async waitFor(exec, cond) {
        await this.sleep(this.settleMs);
        const deadline = this.now() + this.rebootTimeoutMs;
        let seen = false;
        let last = "";
        for (;;) {
            const i = await ros.readInfo(exec);
            if (i.ok) {
                seen = true;
                if (cond(i)) {
                    return { ok: true, note: "" };
                }
                last = `meldet RouterOS ${i.version}${i.rbCurrent ? `, RouterBOARD ${i.rbCurrent}` : ""}`;
            } else {
                last = i.error || "";
            }
            if (this.now() >= deadline) {
                break;
            }
            await this.sleep(this.pollMs);
        }
        return {
            ok: false,
            note: seen
                ? `Router ${last}`
                : `Router nach dem Neustart nicht wieder erreichbar (${last})`,
        };
    }
}

module.exports = { RouterUpdater };
