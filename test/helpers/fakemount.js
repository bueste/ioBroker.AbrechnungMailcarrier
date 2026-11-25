"use strict";

// Stands in for socat in tests: creates the device file, stays alive and removes the file when stopped.
// Host "fail" exits at once with an error message.
const fs = require("node:fs");
const [file, host] = process.argv.slice(2);
if (host === "fail") {
    process.stderr.write("E connect: Connection refused\n");
    process.exit(1);
}
fs.writeFileSync(file, "");
process.on("SIGTERM", () => {
    try {
        fs.rmSync(file, { force: true });
    } catch {
        // ignore
    }
    process.exit(0);
});
setInterval(() => {}, 1000);
