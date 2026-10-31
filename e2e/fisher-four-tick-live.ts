import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { deployIsolatedClient, launchBrowser, logout, setSettings, stopScript } from './lib/harness.js';
import { cheatQuiet, mainlandAccount, startScript, teleTo } from './tutorial/harness.js';

type Abi = {
    __rs2b0t: {
        Skills: { xp(skill: string): number };
        Inventory: { count(name: string): number };
    };
};

const SPOT = { x: 2716, z: 3532, level: 0 };
// CI smoke floor; set FOUR_TICK_MIN_XP_HR=90000 for the tuned target run.
const MIN_XP_HR = Number(process.env.FOUR_TICK_MIN_XP_HR ?? 50_000);
const RUN_MS = Number(process.env.FOUR_TICK_MS ?? 180_000);

const xpNow = (page: import('playwright-core').Page): Promise<number> =>
    page.evaluate(() => (globalThis as never as Abi).__rs2b0t.Skills.xp('fishing'));
const count = (page: import('playwright-core').Page, name: string): Promise<number> =>
    page.evaluate(n => (globalThis as never as Abi).__rs2b0t.Inventory.count(n), name);

async function main(): Promise<void> {
    const base = process.env.BASE ?? 'http://localhost:8891';
    const tag = `4t-${Date.now().toString(36).slice(-6)}`;
    const client = deployIsolatedClient(tag);
    const browser = await launchBrowser();
    const page = await browser.newPage();
    const directory = `out/e2e/${tag}`;
    const errors: string[] = [];
    const botLogs: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
        const text = message.text();
        if (/tick manip|4t fly/i.test(text)) botLogs.push(text);
    });
    try {
        await mainlandAccount(page, base, tag, client.page);
        assert(await cheatQuiet(page, 'setstat fishing 99'), 'fishing fixture');
        assert(await teleTo(page, SPOT, 0, 20_000), 'teleport to fly-fishing spot');
        for (const command of ['~clearinv', 'give fly_fishing_rod 1', 'give feather 1000', 'give knife 1', 'give logs 1']) {
            assert(await cheatQuiet(page, command), command);
        }
        await setSettings(page, 'Fisher', {
            fishMethod: 'Fly fishing — trout/salmon',
            location: 'Seers (fly fishing)',
            bank: false,
            cookMode: 'Off',
            toolAcquire: 'Off',
            muleMode: 'Off',
            tickManip: 'Off',
            fourTickFly: true,
            leashRadius: 18
        });
        const startedAt = Date.now();
        await startScript(page, 'Fisher');
        // Wait for the first roll so travel/walk time is excluded.
        const firstRollDeadline = Date.now() + 30_000;
        const startXp = await xpNow(page);
        let measuredXp = startXp;
        while (Date.now() < firstRollDeadline) {
            measuredXp = await xpNow(page);
            if (measuredXp > startXp) break;
            await page.waitForTimeout(250);
        }
        assert(measuredXp > startXp, 'first fishing roll did not land');
        const measuredFrom = Date.now();
        const measuredXpStart = measuredXp;
        const rolls: { at: number; xp: number }[] = [{ at: 0, xp: measuredXp }];
        while (Date.now() - measuredFrom < RUN_MS) {
            await page.waitForTimeout(200);
            const xp = await xpNow(page);
            if (xp > rolls[rolls.length - 1]!.xp) {
                rolls.push({ at: Date.now() - measuredFrom, xp });
            }
        }
        const measuredXpEnd = await xpNow(page);
        const elapsedMs = Date.now() - measuredFrom;
        const gained = measuredXpEnd - measuredXpStart;
        const xpPerHour = elapsedMs > 0 ? Math.round(gained / (elapsedMs / 3_600_000)) : 0;
        const logs = await count(page, 'Logs');
        const knife = await count(page, 'Knife');
        const fish = await count(page, 'Raw trout') + await count(page, 'Raw salmon');
        assert.equal(logs, 1, 'the delay log must not be consumed');
        assert.equal(knife, 1, 'knife kept');
        assert(gained > 0, 'no fishing xp gained');
        assert(xpPerHour >= MIN_XP_HR, `xp/hr ${xpPerHour} below ${MIN_XP_HR}`);
        assert.deepEqual(errors, [], 'browser runtime errors');
        await mkdir(directory, { recursive: true });
        await page.screenshot({ path: `${directory}/four-tick.png` });
        await writeFile(`${directory}/evidence.json`, JSON.stringify({
            status: 'pass', spot: SPOT, startedAt, measuredXpStart, measuredXpEnd,
            gained, elapsedMs, xpPerHour, minXpPerHour: MIN_XP_HR, logs, knife, fish, errors,
            rolls: rolls.length - 1, rollGapsMs: rolls.slice(1).map((r, i) => r.at - rolls[i]!.at), botLogs
        }, null, 2) + '\n');
        console.log('PASS', JSON.stringify({ xpPerHour, gained, rolls: rolls.length - 1, logs, knife, fish, botLogs: botLogs.slice(-5) }));
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
