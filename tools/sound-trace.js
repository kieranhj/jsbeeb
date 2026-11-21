#!/usr/bin/env node
/*
 * sound-trace.js — capture SN76489 register writes from real BBC code.
 *
 * Boots a headless BBC Micro, types the supplied BASIC lines, runs the
 * machine for a given number of cycles, and dumps every byte the OS ROM
 * sent to the sound chip — decoded into channel/field semantics so it
 * can be diffed against an external implementation (e.g. envelope-tool).
 *
 * Usage:
 *   node tools/sound-trace.js [opts] --cmd "ENVELOPE 1,1,..." --cmd "SOUND 1,1,100,20"
 *   echo "SOUND 1,-15,100,20" | node tools/sound-trace.js [opts]
 *
 * Options:
 *   --model NAME        BBC model (default: B-DFS1.2). Atom not supported.
 *   --cmd LINE          BASIC line to type. Repeatable. Reads stdin if absent.
 *   --run-cycles N      CPU cycles to run after the last command (default: 8000000 = ~4s).
 *   --settle-cycles N   Cycles to run after each typed line (default: 500000).
 *   --format json|csv   Output format (default: json).
 *   --pretty            Pretty-print JSON.
 *   --relative-cycles   Report cycles relative to the first captured write.
 *   --skip-cycles N     Drop writes before absolute cycle N (filter boot noise).
 *   --out PATH          Write to file instead of stdout.
 */
import { MachineSession } from "../src/machine-session.js";
import { readFileSync } from "fs";

function parseArgs(argv) {
    const opts = {
        model: "B-DFS1.2",
        cmds: [],
        runCycles: 8_000_000,
        settleCycles: 500_000,
        format: "json",
        pretty: false,
        relativeCycles: false,
        skipCycles: 0,
        out: null,
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case "--model": opts.model = argv[++i]; break;
            case "--cmd": opts.cmds.push(argv[++i]); break;
            case "--run-cycles": opts.runCycles = Number(argv[++i]); break;
            case "--settle-cycles": opts.settleCycles = Number(argv[++i]); break;
            case "--format": opts.format = argv[++i]; break;
            case "--pretty": opts.pretty = true; break;
            case "--relative-cycles": opts.relativeCycles = true; break;
            case "--skip-cycles": opts.skipCycles = Number(argv[++i]); break;
            case "--out": opts.out = argv[++i]; break;
            case "-h":
            case "--help":
                process.stdout.write(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(2, 22).join("\n").replace(/^ \*+ ?/gm, "") + "\n");
                process.exit(0);
                break;
            default:
                console.error(`Unknown argument: ${a}`);
                process.exit(2);
        }
    }
    if (opts.cmds.length === 0) {
        const stdin = readFileSync(0, "utf8");
        opts.cmds = stdin.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    }
    if (opts.cmds.length === 0) {
        console.error("No commands supplied (use --cmd or pipe via stdin).");
        process.exit(2);
    }
    return opts;
}

/**
 * Decode an SN76489 bus byte using the latched-register state at write time.
 * Returns the same shape as our trace records.
 */
function decode(byte, latchedRegisterAtWrite) {
    let command;
    let usedLatch;
    if (byte & 0x80) {
        command = byte & 0xf0;
        usedLatch = false;
    } else {
        command = latchedRegisterAtWrite;
        usedLatch = true;
    }
    const channel = (command >> 5) & 0x03;
    const isVolume = !!(command & 0x10);
    const low4 = byte & 0x0f;
    const data6 = byte & 0x3f;

    let kind, field;
    if (isVolume) {
        kind = "vol";          // 0 = loudest, 15 = silent (SN76489 attenuation)
        field = low4;
    } else if (channel === 3) {
        kind = "noise";        // bit 2 = white/periodic, bits 0-1 = shift rate / tone2
        field = low4;
    } else if (byte & 0x80) {
        // First byte of a tone register write contains low 4 bits of the period.
        kind = "periodLo";
        field = low4;
    } else {
        // Second byte (no MSB) carries upper 6 bits.
        kind = "periodHi";
        field = data6;
    }
    return { channel, kind, field, usedLatch };
}

async function main() {
    const opts = parseArgs(process.argv);
    if (opts.model.toLowerCase().startsWith("atom")) {
        console.error("Atom uses a different sound chip (FakeSoundChip in headless mode); not supported.");
        process.exit(2);
    }

    const session = new MachineSession(opts.model);
    await session.initialise();
    await session.boot(30);
    session.drainOutput();

    const chip = session._soundChip;
    chip.startCapture();

    for (const line of opts.cmds) {
        await session.type(line);
        await session.runFor(opts.settleCycles);
    }
    await session.runFor(opts.runCycles);

    const writes = chip.stopCapture();

    // Re-decode in order, tracking the latched register state as the OS would have seen it.
    // We must walk every write to keep the latch state correct, even if filtered out.
    let latched = 0;
    const decoded = [];
    for (const w of writes) {
        const d = decode(w.value, latched);
        if (w.value & 0x80) latched = w.value & 0x70;
        if (w.cycle < opts.skipCycles) continue;
        decoded.push({
            cycle: w.cycle,
            byte: w.value,
            byteHex: "0x" + w.value.toString(16).padStart(2, "0"),
            ...d,
        });
    }

    if (opts.relativeCycles && decoded.length) {
        const t0 = decoded[0].cycle;
        for (const e of decoded) e.cycle -= t0;
    }

    let output;
    if (opts.format === "csv") {
        const lines = ["cycle,byte,channel,kind,field,usedLatch"];
        for (const e of decoded) {
            lines.push(`${e.cycle},${e.byteHex},${e.channel},${e.kind},${e.field},${e.usedLatch}`);
        }
        output = lines.join("\n") + "\n";
    } else {
        output = JSON.stringify(decoded, null, opts.pretty ? 2 : 0) + "\n";
    }

    if (opts.out) {
        const { writeFileSync } = await import("fs");
        writeFileSync(opts.out, output);
        console.error(`Wrote ${decoded.length} entries to ${opts.out}`);
    } else {
        process.stdout.write(output);
    }

    session.destroy();
}

main().catch(err => { console.error(err); process.exit(1); });
