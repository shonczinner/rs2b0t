import { Bank } from '../../api/bank/Bank.js';
import { Banking } from '../../api/bank/Banking.js';
import { Equipment } from '../../api/equipment/Equipment.js';
import { Execution } from '../../api/execution/Execution.js';
import { GroundItems } from '../../api/grounditems/GroundItems.js';
import { Inventory } from '../../api/inventory/Inventory.js';
import { Locs } from '../../api/locs/Locs.js';
import { Shop } from '../../api/shop/Shop.js';
import { Traversal } from '../../api/walking/Traversal.js';
import Tile from '../../geometry/Tile.js';
import { isFletchableLogName } from '../GatheringBot/TickManipLogic.js';

const BANK_TILE = new Tile(2725, 3491, 0);
const KNIFE_SPAWN = new Tile(2704, 3475, 0);
const AXE_SPAWN = new Tile(2678, 3731, 0);
const TREE_AREA = new Tile(2724, 3474, 0);
const GERRANT = new Tile(3013, 3224, 0);
const ROD_COINS = 100;
const ROD_PRICE = 10;
const KNIFE = 'Knife';
const ROD = 'Fly fishing rod';
const AXE_NAMES = ['Bronze axe', 'Iron axe', 'Steel axe', 'Black axe', 'Mithril axe', 'Adamant axe', 'Rune axe'];

export interface ProvisionHost {
    log(message: string): void;
    setStatus(message: string): void;
    finish(reason: string): void;
    feathers(): number;
}

/** Owns every acquisition step for the Seers 3-tick kit. */
export class Seers3tProvisioner {
    private bankPrepared = false;

    constructor(private readonly host: ProvisionHost) {}

    async ensureAll(): Promise<boolean> {
        if (this.kitComplete()) return true;
        const rodMissing = Inventory.count(ROD) < 1 && !Equipment.contains(ROD);
        const axeMissing = !AXE_NAMES.some(n => Inventory.count(n) > 0 || Equipment.contains(n));
        const needBank = (rodMissing && Inventory.count('Coins') < ROD_PRICE)
            || axeMissing
            || Inventory.count(KNIFE) < 1
            || !this.carrierLog()
            || Inventory.count('Feather') < 500;
        if (needBank && !(await this.bankPrepare())) return false;
        if (!(await this.ensureFeathers())) return false;
        if (!(await this.ensureAxe())) return false;
        if (!(await this.ensureKnife())) return false;
        if (!(await this.ensureLog())) return false;
        return this.ensureRod();
    }

    private kitComplete(): boolean {
        return (Inventory.count(ROD) > 0 || Equipment.contains(ROD))
            && AXE_NAMES.some(n => Inventory.count(n) > 0 || Equipment.contains(n))
            && Inventory.count(KNIFE) > 0
            && this.carrierLog() !== null
            && Inventory.count('Feather') >= 500;
    }

    /** Bank-first pass: rod, axe, knife and rod coins before any long walk. */
    private async bankPrepare(): Promise<boolean> {
        if (this.bankPrepared) return true;
        if (!(await this.openBank())) return false;
        const haveRod = Inventory.count(ROD) > 0 || Equipment.contains(ROD);
        if (!haveRod && Bank.count(ROD) > 0) {
            await Bank.withdrawX(ROD, 1);
            await Execution.delayUntilTicks(() => Inventory.count(ROD) > 0, 4);
        }
        for (const name of AXE_NAMES) {
            if (AXE_NAMES.some(n => Inventory.count(n) > 0 || Equipment.contains(n))) break;
            if (Bank.count(name) < 1) continue;
            await Bank.withdrawX(name, 1);
            await Execution.delayUntilTicks(() => Inventory.count(name) > 0 || Equipment.contains(name), 4);
        }
        if (Inventory.count(KNIFE) < 1 && Bank.count(KNIFE) > 0) {
            await Bank.withdrawX(KNIFE, 1);
            await Execution.delayUntilTicks(() => Inventory.count(KNIFE) > 0, 4);
        }
        if (Inventory.count('Feather') < 500) {
            const want = Math.max(0, this.host.feathers() - Inventory.count('Feather'));
            if (want > 0) await Bank.withdrawX('Feather', want);
        }
        if (!this.carrierLog()) {
            for (const name of ['Logs', 'Oak logs', 'Willow logs']) {
                if (Bank.count(name) < 1) continue;
                await Bank.withdrawX(name, 1);
                await Execution.delayUntilTicks(() => this.carrierLog() !== null, 4);
                break;
            }
        }
        const stillNeedsRod = Inventory.count(ROD) < 1 && !Equipment.contains(ROD);
        const missingCoins = Math.max(0, ROD_COINS - Inventory.count('Coins'));
        if (stillNeedsRod && missingCoins > 0 && Bank.count('Coins') > 0) {
            await Bank.withdrawX('Coins', Math.min(missingCoins, Bank.count('Coins')));
        }
        await Bank.close();
        this.bankPrepared = true;
        return true;
    }

    async ensureFeathers(): Promise<boolean> {
        return Inventory.count('Feather') > 0;
    }

    async ensureRod(): Promise<boolean> {
        if (Inventory.count(ROD) > 0 || Equipment.contains(ROD)) return true;
        this.host.setStatus('looking for a fly fishing rod');
        if (Inventory.count('Coins') < ROD_PRICE) {
            if (await this.openBank()) {
                const need = ROD_COINS - Inventory.count('Coins');
                if (Bank.count('Coins') > 0) await Bank.withdrawX('Coins', Math.min(need, Bank.count('Coins')));
                await Bank.close();
            }
        }
        if (Inventory.count('Coins') < ROD_PRICE) {
            this.host.setStatus('no coins for a fly fishing rod — stopping');
            this.host.finish('Seers3tFisher: no coins for a fly fishing rod');
            return false;
        }
        return this.buyRod();
    }

    async ensureAxe(): Promise<boolean> {
        if (AXE_NAMES.some(n => Inventory.count(n) > 0 || Equipment.contains(n))) return true;
        this.host.setStatus('looking for an axe');
        if (await this.bankWithdraw(AXE_NAMES)) return true;
        await this.takeGround(AXE_NAMES, AXE_SPAWN, 'axe');
        return AXE_NAMES.some(n => Inventory.count(n) > 0 || Equipment.contains(n));
    }

    async ensureKnife(): Promise<boolean> {
        if (Inventory.count(KNIFE) > 0 || Equipment.contains(KNIFE)) return true;
        this.host.setStatus('looking for a knife');
        if (await this.bankWithdraw([KNIFE])) return true;
        await this.takeGround([KNIFE], KNIFE_SPAWN, 'knife');
        return Inventory.count(KNIFE) > 0;
    }

    async ensureLog(): Promise<boolean> {
        if (this.carrierLog()) return true;
        this.host.setStatus('chopping a carrier log');
        if (await this.tryChopTrees()) return true;
        await Traversal.walkResilient(TREE_AREA, { radius: 8, attempts: 3, timeoutMs: 300_000, log: m => this.host.log(m) });
        return this.tryChopTrees();
    }

    /** Any normal or dead tree is fine; oak/willow need a level check. */
    private async tryChopTrees(): Promise<boolean> {
        const trees = Locs.query()
            .name('Tree', 'Dead tree')
            .action('Chop down')
            .results()
            .sort((a, b) => a.distance() - b.distance())
            .slice(0, 4);
        for (const tree of trees) {
            const tile = tree.tile();
            this.host.setStatus(`chopping a carrier log at ${tile.x},${tile.z}`);
            if (!(await Traversal.walkTo(tile, { radius: 2, timeoutMs: 45_000, log: m => this.host.log(m) }))) continue;
            await tree.interact('Chop down');
            if (await Execution.delayUntilTicks(() => this.carrierLog() !== null, 20)) return true;
        }
        return false;
    }

    private carrierLog() {
        return Inventory.items().find(i => isFletchableLogName(i.name)) ?? null;
    }

    private async buyRod(): Promise<boolean> {
        this.host.setStatus('buying a fly fishing rod from Gerrant');
        await Traversal.walkResilient(GERRANT, { radius: 3, attempts: 4, timeoutMs: 300_000, log: m => this.host.log(m) });
        if (!(await Shop.open('Gerrant'))) return false;
        try {
            if ((await Shop.buy(ROD, 1)) < 1) return false;
            await Execution.delayUntilTicks(() => Inventory.count(ROD) > 0, 4);
        } finally {
            await Shop.close();
        }
        return Inventory.count(ROD) > 0;
    }

    private async bankWithdraw(names: readonly string[]): Promise<boolean> {
        if (!(await this.openBank())) return false;
        for (const name of names) {
            if (Bank.count(name) < 1) continue;
            await Bank.withdrawX(name, 1);
            if (await Execution.delayUntilTicks(() => Inventory.count(name) > 0 || Equipment.contains(name), 4)) {
                await Bank.close();
                return true;
            }
        }
        await Bank.close();
        return false;
    }

    private async openBank(): Promise<boolean> {
        if (!(await Traversal.walkResilient(BANK_TILE, { radius: 2, attempts: 3, timeoutMs: 300_000, log: m => this.host.log(m) }))) return false;
        if (!(await Banking.open({ stand: BANK_TILE, log: m => this.host.log(m) }))) return false;
        return Bank.waitReady(4000, m => this.host.log(m));
    }

    private async takeGround(names: readonly string[], spawn: Tile, label: string): Promise<void> {
        const here = GroundItems.query().name(...names).within(12).nearest();
        if (here) {
            this.host.setStatus(`taking a ${label}`);
            await here.interact('Take');
            await Execution.delayUntilTicks(() => names.some(n => Inventory.count(n) > 0), 6);
            if (names.some(n => Inventory.count(n) > 0)) return;
        }
        this.host.setStatus(`walking to the ${label} spawn`);
        await Traversal.walkResilient(spawn, { radius: 2, attempts: 4, timeoutMs: 300_000, log: m => this.host.log(m) });
        const drop = GroundItems.query().name(...names).within(8).nearest();
        if (!drop) return;
        await drop.interact('Take');
        await Execution.delayUntilTicks(() => names.some(n => Inventory.count(n) > 0), 6);
    }
}
