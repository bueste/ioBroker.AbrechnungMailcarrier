"use strict";

// Stands in for socat in tests: speaks a minimal M-Bus segment on stdin/stdout. A short frame to address 5
// (SND_NKE) is acknowledged with E5, everything else stays unanswered.
let buf = Buffer.alloc(0);
process.stdin.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 5) {
        if (buf[0] !== 0x10) {
            buf = buf.subarray(1);
            continue;
        }
        const frame = buf.subarray(0, 5);
        buf = buf.subarray(5);
        if (frame[1] === 0x40 && frame[2] === 5) {
            process.stdout.write(Buffer.from([0xe5]));
        }
    }
});
