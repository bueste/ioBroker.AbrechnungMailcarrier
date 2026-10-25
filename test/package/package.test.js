"use strict";

const path = require("path");
const { tests } = require("@iobroker/testing");

// Standard ioBroker consistency checks: validates that package.json and io-package.json
// exist, are valid JSON, and agree with each other (name, version, ...).
tests.packageFiles(path.join(__dirname, "..", ".."));
