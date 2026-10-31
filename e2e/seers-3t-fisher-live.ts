import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { deployIsolatedClient, launchBrowser, logout, setSettings, stopScript } from './lib/harness.js';
import { cheatQuiet, mainlandAccount, startScript, teleTo } from './tutorial/harness.js';

type Abi = {
    __rs2b0t: {
        Skills: { xp(skill: string): number; level(skill: string): number };
        Inventory: { count(name: string): number };
    };
};

const SPOT = { x: 2716, z: 3532, level: 0 };
const MIN_XP_HR = Number(process.env.SEERS_3T_MIN_XP_HR ?? 90_000);
const RUN_MS = Number(process.env.SEERS_3T_MS ?? 120_000);

const xpNow = (page: import('playwright-core').Page): Promise<number> =>
    page.evaluate(() => (globalThis as never as Abi).__rs2b0t.Skills.xp('fishing'));
const count = (page: import('playwright-core').Page, name: string): Promise<number> =>
    page.evaluate(n => (globalThis as never as Abi).__rs2b0t.Inventory.count(n), name);

async function main(): Promise<void> {
    const base = process.env.BASE ?? 'http://localhost:8888';
    const tag = `s3t-${Date.now().toString(36).slice(-6)}`;
    const client = deployIsolatedClient(tag);
    const browser = await launchBrowser();
    const page = await browser.newPage();
    const directory = `out/e2e/${tag}`;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await mainlandAccount(page, base, tag, client.page);
        assert(await cheatQuiet(page, 'setstat fishing 99'), 'fishing fixture');
        assert(await teleTo(page, SPOT, 0, 20_000), 'teleport to Seers spot');
        for (const command of ['~clearinv', 'give fly_fishing_rod 1', 'give feather 5000', 'give bronze_axe 1', 'give knife 1']) {
            assert(await cheatQuiet(page, command), command);
        }
        await setSettings(page, 'Seers3tFisher', { feathers: 5000, dropFish: true });
        await startScript(page, 'Seers3tFisher');
        const firstRollDeadline = Date.now() + 240_000;
        const startXp = await xpNow(page);
        let measuredXp = startXp;
        while (Date.now() < firstRollDeadline) {
            measuredXp = await xpNow(page);
            if (measuredXp > startXp) break;
            await page.waitForTimeout(250);
        }
        if (measuredXp <= startXp) {
            console.log('STATE', JSON.stringify(await page.evaluate(() => {
                const g = globalThis as never as { rs2b0t: { runner: { bot?: { status?: string }; ctx?: { log?: { msg: string }[] } }, reader: { worldTile(): unknown } }, __rs2b0t: { Inventory: { items(): { name: string | null; count: number }[] } } };
                return {
                    status: g.rs2b0t.runner.bot?.status,
                    tile: g.rs2b0t.reader.worldTile(),
                    inv: g.__rs2b0t.Inventory.items().map(i => [i.name, i.count]),
                    log: g.rs2b0t.runner.ctx?.log?.slice(-12).map(l => l.msg)
                };
            })));
        }
        assert(measuredXp > startXp, 'first fishing roll did not land after provisioning');
        const measuredFrom = Date.now();
        const measuredXpStart = measuredXp;
        await page.waitForTimeout(RUN_MS);
        const measuredXpEnd = await xpNow(page);
        const elapsedMs = Date.now() - measuredFrom;
        const gained = measuredXpEnd - measuredXpStart;
        const xpPerHour = elapsedMs > 0 ? Math.round(gained / (elapsedMs / 3_600_000)) : 0;
        const kit = {
            axe: await page.evaluate(() => [
                'Bronze axe', 'Iron axe', 'Steel axe', 'Black axe', 'Mithril axe', 'Adamant axe', 'Rune axe'
            ].reduce((n, name) => n + (globalThis as never as Abi).__rs2b0t.Inventory.count(name), 0)),
            knife: await count(page, 'Knife'),
            logs: await count(page, 'Logs')
        };
        const fishingLevel = await page.evaluate(() => (globalThis as never as Abi).__rs2b0t.Skills.level('fishing'));
        const debug = await page.evaluate(() => {
            const bot = (globalThis as never as { rs2b0t: { runner: { bot?: { rollGaps?: number[]; fishCaught?: number; phase?: string; status?: string } } } }).rs2b0t.runner.bot;
            return { gaps: bot?.rollGaps?.slice(-12), fish: bot?.fishCaught, phase: bot?.phase, status: bot?.status };
        });
        console.log('DEBUG', JSON.stringify(debug));
        assert(kit.axe > 0, 'axe provisioned');
        assert.equal(kit.knife, 1, 'knife provisioned');
        assert.equal(kit.logs, 1, 'one carrier log kept');
        assert(gained > 0, 'no fishing xp gained');
        assert(xpPerHour >= MIN_XP_HR, `xp/hr ${xpPerHour} below ${MIN_XP_HR}`);
        assert.deepEqual(errors, [], 'browser runtime errors');
        await mkdir(directory, { recursive: true });
        await page.screenshot({ path: `${directory}/seers-3t.png` });
        await writeFile(`${directory}/evidence.json`, JSON.stringify({
            status: 'pass', spot: SPOT, fishingLevel, kit, measuredXpStart, measuredXpEnd,
            gained, elapsedMs, xpPerHour, minXpPerHour: MIN_XP_HR, errors
        }, null, 2) + '\n');
        console.log('PASS', JSON.stringify({ fishingLevel, kit, xpPerHour, gained }));
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
