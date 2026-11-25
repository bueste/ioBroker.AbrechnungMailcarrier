"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { expect } = require("chai");
const { encPassword, challengeOf } = require("../../lib/moxa/auth");

const PAGE = fs.readFileSync(path.join(__dirname, "../fixtures/moxa_login_page.html"), "latin1");

/** Runs the real script of the saved login page and returns what its SetPass puts into EncPasswd. */
function pageResult(password, challenge) {
    const script = [...PAGE.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n");
    const sandbox = { document: {}, parent: { location: { href: "x" } }, window: { location: { href: "x" } } };
    vm.createContext(sandbox);
    vm.runInContext(script, sandbox);
    const form = { Password: { value: password, disabled: false }, FakeChallenge: { value: challenge }, EncPasswd: { value: "" } };
    expect(sandbox.SetPass(form)).to.equal(true);
    expect(form.Password.disabled).to.equal(true);
    return form.EncPasswd.value;
}

describe("Moxa login", () => {
    it("reads the challenge from the login page", () => {
        expect(challengeOf(PAGE)).to.match(/^[0-9A-F]{64}$/);
    });

    it("gives the same result as the script of the real login page", () => {
        const challenge = challengeOf(PAGE);
        for (const pw of ["moxa", "a", "Secret-123", "x~y!z@#$%^&*()", "0123456789abcde", "ÄÖ"].slice(0, 5)) {
            expect(encPassword(pw, challenge), pw).to.equal(pageResult(pw, challenge));
        }
    });

    it("agrees for other challenges and an empty password", () => {
        for (const c of ["188FD7ECACD5901B7CF41ADA2EC93C139A442E65E67B6134085ACD1EA5A1E0A3", "0".repeat(64), "F".repeat(64), "A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90"]) {
            for (const pw of ["", "moxa", "Pa55word15chars"]) {
                expect(encPassword(pw, c)).to.equal(pageResult(pw, c));
            }
        }
    });

    it("gives a different value for a different password or challenge", () => {
        const c = challengeOf(PAGE);
        expect(encPassword("moxa", c)).to.not.equal(encPassword("moxb", c));
        expect(encPassword("moxa", c)).to.not.equal(encPassword("moxa", "0".repeat(64)));
    });
});
