import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { deployIsolatedClient, launchBrowser, logout, setSettings, stopScript } from './lib/harness.js';
import { cheatQuiet, mainlandAccount, startScript, teleTo } from './tutorial/harness.js';
import { cadence } from './fisher-shilo/cadence.js';

type Abi = {
    __rs2b0t: {
        Skills: { xp(skill: string): number; level(skill: string): number };
        Inventory: { count(name: string): number; used(): number };
        Equipment: { contains(name: string): boolean };
    };
};

const CAMP = { x: 2711, z: 3500, level: 0 };
const WILLOW_LOG_XP = 67.5;
// Override after measuring on a slower host.
const MIN_XP_HR = Number(process.env.WC_3T_MIN_XP_HR ?? 100_000);
const RUN_MS = Number(process.env.WC_3T_MS ?? 60_000);
const PACK_FILL = Number(process.env.WC_3T_PACK ?? 24);

const xpNow = (page: import('playwright-core').Page): Promise<number> =>
    page.evaluate(() => (globalThis as never as Abi).__rs2b0t.Skills.xp('woodcutting'));
const count = (page: import('playwright-core').Page, name: string): Promise<number> =>
    page.evaluate(n => (globalThis as never as Abi).__rs2b0t.Inventory.count(n), name);
const used = (page: import('playwright-core').Page): Promise<number> =>
    page.evaluate(() => (globalThis as never as Abi).__rs2b0t.Inventory.used());

async function waitForXp(page: import('playwright-core').Page, from: number, deadlineMs: number): Promise<number> {
    const deadline = Date.now() + deadlineMs;
    let xp = from;
    while (Date.now() < deadline) {
        xp = await xpNow(page);
        if (xp > from) return xp;
        await page.waitForTimeout(250);
    }
    return xp;
}

async function main(): Promise<void> {
    const base = process.env.BASE ?? 'http://localhost:8888';
    const tag = `w3t-${Date.now().toString(36).slice(-6)}`;
    const client = deployIsolatedClient(tag);
    const browser = await launchBrowser();
    const page = await browser.newPage();
    const directory = `out/e2e/${tag}`;
    const errors: string[] = [];
    const botLogs: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
        const text = message.text();
        if (/tick manip|farmer|3t|restock|kit:/i.test(text)) botLogs.push(text);
    });
    try {
        await mainlandAccount(page, base, tag, client.page);
        const timing = await cadence(page, false);
        assert(timing.after >= 550 && timing.after <= 650, `600ms server required (measured ${timing.after}ms)`);
        assert(await cheatQuiet(page, 'setstat woodcutting 99'), 'woodcutting fixture');
        assert(await cheatQuiet(page, 'setstat fletching 99'), 'fletching fixture');
        assert(await teleTo(page, CAMP, 0, 20_000), 'teleport to Seers Willows');
        // Deliberately no knife: the Woodcutter must provision it for the 3-tick cycle.
        for (const command of ['~clearinv', 'give rune_axe 1', 'give logs 1']) {
            assert(await cheatQuiet(page, command), command);
        }
        await setSettings(page, 'Woodcutter', {
            treeName: 'Willow',
            location: 'Seers Willows',
            bank: false,
            burnMode: 'Off',
            toolAcquire: 'Off',
            muleMode: 'Off',
            tickManip: 'Off',
            threeTickWoodcut: process.env.WC_3T_OFF !== '1'
        });
        await startScript(page, 'Woodcutter');

        const startXp = await xpNow(page);
        const firstRoll = await waitForXp(page, startXp, 240_000);
        if (firstRoll <= startXp) {
            console.log('STATE', JSON.stringify(await page.evaluate(() => {
                const g = globalThis as never as {
                    rs2b0t: { runner: { bot?: { status?: string }; ctx?: { log?: { msg: string }[] } }; reader: { worldTile(): unknown } };
                    __rs2b0t: { Inventory: { items(): { name: string | null; count: number }[] } };
                };
                return {
                    status: g.rs2b0t.runner.bot?.status,
                    tile: g.rs2b0t.reader.worldTile(),
                    inv: g.__rs2b0t.Inventory.items().map(i => [i.name, i.count]),
                    log: g.rs2b0t.runner.ctx?.log?.slice(-16).map(l => l.msg)
                };
            })));
        }
        assert(firstRoll > startXp, 'first 3-tick chop did not land after provisioning');
        const knife = await count(page, 'Knife');
        const axe = await page.evaluate(() => {
            const g = globalThis as never as Abi;
            return ['Bronze axe', 'Iron axe', 'Steel axe', 'Black axe', 'Mithril axe', 'Adamant axe', 'Rune axe']
                .some(name => g.__rs2b0t.Inventory.count(name) > 0 || g.__rs2b0t.Equipment.contains(name));
        });
        assert.equal(knife, 1, 'knife provisioned');
        assert(axe, 'axe kept');

        const fletchStart = await page.evaluate(() => (globalThis as never as Abi).__rs2b0t.Skills.xp('fletching'));
        const measuredFrom = Date.now();
        const measuredXpStart = firstRoll;
        await page.waitForTimeout(RUN_MS);
        const measuredXpEnd = await xpNow(page);
        const elapsedMs = Date.now() - measuredFrom;
        const gained = measuredXpEnd - measuredXpStart;
        const xpPerHour = elapsedMs > 0 ? Math.round(gained / (elapsedMs / 3_600_000)) : 0;
        const logsPerHour = Math.round(xpPerHour / WILLOW_LOG_XP);
        if (gained <= 0) {
            console.log('STATE', JSON.stringify(await page.evaluate(() => {
                const g = globalThis as never as {
                    rs2b0t: { runner: { bot?: { status?: string }; ctx?: { log?: { msg: string }[] } }; reader: { worldTile(): unknown } };
                    __rs2b0t: { Inventory: { items(): { name: string | null; count: number }[]; used(): number } };
                };
                return {
                    status: g.rs2b0t.runner.bot?.status,
                    tile: g.rs2b0t.reader.worldTile(),
                    used: g.__rs2b0t.Inventory.used(),
                    inv: g.__rs2b0t.Inventory.items().map(i => [i.name, i.count]),
                    log: g.rs2b0t.runner.ctx?.log?.slice(-60).map(l => l.msg)
                };
            })));
            console.log('DIAG', JSON.stringify(await page.evaluate(() => {
                const g = globalThis as never as {
                    rs2b0t: { runner: { bot?: { farmerCycleStartTick?: () => number } }; reader: { worldTile(): unknown } };
                    __rs2b0t: {
                        Game: { tick(): number; animating(): boolean };
                        Equipment: { items(): { name: string | null }[] };
                        Inventory: { items(): { name: string | null; count: number }[] };
                        Locs: { query(): { name(n: string): { results(): unknown[] } } };
                    };
                };
                const bot = g.rs2b0t.runner.bot;
                return {
                    tick: g.__rs2b0t.Game.tick(),
                    start: bot?.farmerCycleStartTick?.(),
                    anim: g.__rs2b0t.Game.animating(),
                    tile: g.rs2b0t.reader.worldTile(),
                    equipped: g.__rs2b0t.Equipment.items().map(i => i.name),
                    inv: g.__rs2b0t.Inventory.items().map(i => [i.name, i.count]),
                    willows: g.__rs2b0t.Locs.query().name('Willow').results().length
                };
            })));
        }
        assert(gained > 0, 'no woodcutting xp gained');
        const tickDebug = await page.evaluate(() => {
            const bot = (globalThis as never as {
                rs2b0t: { runner: { bot?: { threeTickWoodcutDebug?: () => unknown } } };
            }).rs2b0t.runner.bot;
            return bot?.threeTickWoodcutDebug?.() ?? null;
        });
        const batchGaps = (tickDebug as { gaps?: number[] } | null)?.gaps ?? [];
        const fletchEnd = await page.evaluate(() => (globalThis as never as Abi).__rs2b0t.Skills.xp('fletching'));
        const logsHeld = await page.evaluate(() => {
            const g = globalThis as never as Abi;
            return ['Logs', 'Oak logs', 'Willow logs', 'Maple logs', 'Yew logs', 'Magic logs']
                .reduce((n, name) => n + g.__rs2b0t.Inventory.count(name), 0);
        });
        const trace = await page.evaluate(() => {
            const r = (globalThis as never as { rs2b0t: { reader: { gameMessages(): string[] } } }).rs2b0t.reader;
            return r.gameMessages().filter(line => line.includes('DBG')).slice(-30);
        });
        console.log('TRACE', JSON.stringify(trace));
        console.log('DEBUG', JSON.stringify({ xpPerHour, gained, batchGaps, fletchGained: fletchEnd - fletchStart, logsHeld, tickDebug }));
        if (process.env.WC_3T_OFF !== '1') {
            assert(batchGaps.length > 0, 'no 3-tick batches recorded');
            // Gap histogram is diagnostic; XP/hr is the gate.
        }
        assert(xpPerHour >= MIN_XP_HR, `xp/hr ${xpPerHour} below ${MIN_XP_HR}`);

        // Full pack: power mode drops logs; the cycle must keep chopping.
        const usedBefore = await used(page);
        const fillXp = await xpNow(page);
        assert(await cheatQuiet(page, `give willow_logs ${PACK_FILL}`), 'fill pack with willow logs');
        const usedFull = await used(page);
        assert(usedFull >= usedBefore, 'pack did not fill');
        const clearDeadline = Date.now() + 180_000;
        let usedAfter = usedFull;
        while (Date.now() < clearDeadline) {
            usedAfter = await used(page);
            if (usedAfter <= usedFull - Math.min(10, PACK_FILL / 2)) break;
            await page.waitForTimeout(500);
        }
        const resumeXp = await waitForXp(page, fillXp, 120_000);
        if (resumeXp <= fillXp) {
            console.log('STATE', JSON.stringify(await page.evaluate(() => {
                const g = globalThis as never as {
                    rs2b0t: { runner: { bot?: { status?: string }; ctx?: { log?: { msg: string }[] } }; reader: { worldTile(): unknown } };
                    __rs2b0t: { Inventory: { items(): { name: string | null; count: number }[]; used(): number } };
                };
                return {
                    status: g.rs2b0t.runner.bot?.status,
                    tile: g.rs2b0t.reader.worldTile(),
                    used: g.__rs2b0t.Inventory.used(),
                    inv: g.__rs2b0t.Inventory.items().map(i => [i.name, i.count]),
                    log: g.rs2b0t.runner.ctx?.log?.slice(-16).map(l => l.msg)
                };
            })));
        }
        assert(usedAfter < usedFull, `pack did not clear (used ${usedAfter}/${usedFull})`);
        assert(resumeXp > fillXp, 'chopping did not resume after the pack filled');
        assert.equal(await count(page, 'Knife'), 1, 'knife kept through the full pack');
        const logsKept = await page.evaluate(() => {
            const g = globalThis as never as Abi;
            return ['Logs', 'Oak logs', 'Willow logs', 'Maple logs', 'Yew logs', 'Magic logs']
                .reduce((n, name) => n + g.__rs2b0t.Inventory.count(name), 0);
        });
        assert(logsKept >= 1, 'the carrier log must never be dropped');

        const woodcuttingLevel = await page.evaluate(() => (globalThis as never as Abi).__rs2b0t.Skills.level('woodcutting'));
        const fletchingLevel = await page.evaluate(() => (globalThis as never as Abi).__rs2b0t.Skills.level('fletching'));
        assert.deepEqual(errors, [], 'browser runtime errors');
        await mkdir(directory, { recursive: true });
        await page.screenshot({ path: `${directory}/woodcutter-three-tick.png` });
        await writeFile(`${directory}/evidence.json`, JSON.stringify({
            status: 'pass', camp: CAMP, tickMs: timing.after, woodcuttingLevel, fletchingLevel,
            measuredXpStart, measuredXpEnd, gained, elapsedMs, xpPerHour, logsPerHour,
            minXpPerHour: MIN_XP_HR, knife, axe, usedBefore, usedFull, usedAfter, batchGaps, tickDebug, errors, botLogs
        }, null, 2) + '\n');
        console.log('PASS', JSON.stringify({
            tickMs: timing.after, woodcuttingLevel, fletchingLevel, xpPerHour, logsPerHour,
            gained, knife, axe, usedBefore, usedFull, usedAfter, batchGaps, tickDebug, botLogs: botLogs.slice(-8)
        }));
    } finally {
        await stopScript(page).catch(() => undefined);
        await logout(page).catch(() => undefined);
        await browser.close();
        client.cleanup();
    }
}

if (import.meta.main) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
