#!/usr/bin/env node
// Find the BBC OS volume lookup table by scanning the OS ROM (0xC000-0xFFFF)
// for a 128-byte region whose entries at known BBC amplitudes match the
// SN attenuations observed in trace-env1.json.
import { MachineSession } from "../src/machine-session.js";

const session = new MachineSession("B-DFS1.2");
await session.initialise();
await session.boot(10);

// (BBC amp, expected SN attenuation) — derived from trace-env1.
const checks = [
    [120, 0], [110, 2], [100, 3], [90, 4], [80, 5],
    [70, 7], [60, 8], [50, 9], [40, 10], [30, 12],
    [20, 13], [10, 14], [0, 15],
];

const candidates = [];
for (let base = 0xc000; base <= 0xff80; base++) {
    let ok = true;
    for (const [amp, att] of checks) {
        if (session._machine.readbyte(base + amp) !== att) { ok = false; break; }
    }
    if (ok) candidates.push(base);
}

console.log(`Found ${candidates.length} candidate base address(es):`);
for (const base of candidates) {
    const table = [];
    for (let i = 0; i < 128; i++) table.push(session._machine.readbyte(base + i));
    console.log(`\n@ 0x${base.toString(16).toUpperCase()}:`);
    console.log(JSON.stringify(table));
}

session.destroy();
