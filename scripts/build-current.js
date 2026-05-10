"use strict";

const path = require("path");
const { binaryName, runPkg, targetForCurrentPlatform } = require("./build-lib");

const target = targetForCurrentPlatform();
const platform = target.split("-")[1];
runPkg(target, path.join("dist", "current", binaryName(platform)));
