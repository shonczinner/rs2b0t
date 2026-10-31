import { actions, reader } from '../../adapter/ClientAdapter.js';
import { Bank } from '../../api/bank/Bank.js';
import { LoopingBot } from '../../api/bot/Bot.js';
import { Equipment } from '../../api/equipment/Equipment.js';
import { Execution } from '../../api/execution/Execution.js';
import { Game } from '../../api/game/Game.js';
import { GroundItems } from '../../api/grounditems/GroundItems.js';
import { Inventory } from '../../api/inventory/Inventory.js';
import { Locs } from '../../api/locs/Locs.js';
import { Npcs } from '../../api/npcs/Npcs.js';
import { Skills } from '../../api/skills/Skills.js';
import { Traversal } from '../../api/walking/Traversal.js';
import Tile from '../../geometry/Tile.js';
import { Input } from '../../input/Input.js';
import { paintLevels, scriptFrame, XpTracker } from '../../paint/jive.js';
import { fmtDuration } from '../../paint/paintLogic.js';
import { BotHost } from '../../runtime/BotHost.js';
import { ScriptRunner } from '../../runtime/ScriptRunner.js';
import type { SettingsSchema } from '../../runtime/Settings.js';
import { isFletchableLogName } from '../GatheringBot/TickManipLogic.js';

const SPOT = new Tile(2716, 3532, 0);
const BANK = new Tile(2725, 3491, 0);
const TREE_AREA = new Tile(2724, 3474, 0);
const KNIFE_SPAWN = new Tile(2704, 3475, 0);
const AXE_SPAWN = new Tile(2678, 3731, 0);
const KNIFE = 'Knife';
const MAKE1 = 8889;
const ROLL_ANIM = 623;
const FLETCH_ANIM = 1248;
const AXE_NAMES = ['Bronze axe', 'Iron axe', 'Steel axe', 'Black axe', 'Mithril axe', 'Adamant axe', 'Rune axe'];

export const SETTINGS: SettingsSchema = {
    feathers: { type: 'number', default: 10_000, min: 1, label: 'Feathers to withdraw', help: 'bank feathers to carry when starting or restocking' },
    dropFish: { type: 'boolean', default: true, label: 'Drop fish', help: 'power-fish; keep one carrier log and drop the catch' }
};

interface Target {
    index: number;
    interact(op: string): boolean | Promise<boolean>;
}

export default class Seers3tFisher extends LoopingBot {
    override loopDelay = 600;

    private target: Target | null = null;
    private fourTickState: 'native' | 'sent' | 'armed' = 'native';
    private fourTickSent = -1;
    private fourTickRollDue = -1;
    private fourTickLastSerial = -1;
    private lastRollTick = -1;
    private lastCatchTick = -1;
    private lastRaw = 0;
    private stopTick: (() => void) | null = null;
    private status = 'starting';
    private startedAt = Date.now();
    private fishCaught = 0;
    private rollGaps: number[] = [];
    private readonly xp = new XpTracker(['fishing'], Skills);

    override async onStart(): Promise<void> {
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 0);
        this.startedAt = Date.now();
        this.xp.begin();
        this.stopTick = BotHost.addTickListener(() => this.onTick());
        this.log('Seers3tFisher: provisioning axe, knife, log, rod and feathers');
    }

    override onStop(): void {
        this.stopTick?.();
        this.stopTick = null;
    }

    override async loop(): Promise<void> {
        if (!Game.sceneReady()) return;
        if (!(await this.ensureKit())) return;
        if (!(await this.ensureSupplies())) return;
        const here = Game.tile();
        if (!here || Tile.from(here).distanceTo(SPOT) > 3) {
            this.setStatus('walking to the Seers spot');
            await Traversal.walkResilient(SPOT, { radius: 2, attempts: 4, timeoutMs: 120_000, log: m => this.log(m) });
            return;
        }
        this.target = this.findSpot();
        if (!this.target) {
            this.setStatus('waiting for a Lure spot');
            await Execution.delayTicks(2);
            return;
        }
        const tick = Game.tick();
        const idle = this.lastRollTick < 0 || tick - this.lastRollTick > 12;
        if (idle && !Game.animating()) {
            this.setStatus('luring');
            await this.target.interact('Lure');
            await Execution.delayTicks(2);
        }
    }

    private onTick(): void {
        const raw = this.rawFish();
        if (raw > this.lastRaw) {
            this.fishCaught += raw - this.lastRaw;
            this.lastCatchTick = Game.tick();
        }
        this.lastRaw = raw;
        if (!this.target) return;
        const state = reader.selfAnimState();
        if (!state) return;
        const tick = Game.tick();
        const fresh = state.serial !== this.fourTickLastSerial;
        this.fourTickLastSerial = state.serial;

        if (this.fourTickState === 'native') {
            if (fresh && state.seq === ROLL_ANIM) this.sendBatch(tick);
            return;
        }
        if (this.fourTickState === 'sent') {
            if (tick === this.fourTickSent + 1) {
                if (fresh && (state.seq === FLETCH_ANIM || state.seq === ROLL_ANIM)) {
                    this.fourTickState = 'armed';
                    this.fourTickRollDue = tick + 2;
                }
                return;
            }
            if (tick >= this.fourTickSent + 2) this.fallback();
            return;
        }
        if (this.fourTickState === 'armed' && tick >= this.fourTickRollDue) this.sendBatch(tick);
    }

    private sendBatch(tick: number): void {
        if (!this.target) return;
        const knife = Inventory.first(KNIFE);
        const log = this.carrierLog();
        if (!knife || !log) {
            this.setStatus('kit lost — reprovisioning');
            this.fourTickState = 'native';
            return;
        }
        for (const fish of Inventory.items().filter(i => /^Raw (trout|salmon)$/i.test(i.name ?? '')).slice(0, 2)) {
            void fish.interact('Drop');
        }
        Input.useItemOnItem(knife.id, knife.slot, knife.snap.comId, log.id, log.slot, log.snap.comId);
        actions.ifButton(MAKE1);
        Input.interactNpc(this.target.index, 1);
        this.fourTickState = 'sent';
        this.fourTickSent = tick;
        this.rollGaps.push(this.lastRollTick >= 0 ? tick - this.lastRollTick : 0);
        this.lastRollTick = tick;
        this.setStatus(`3-tick batch @${tick}`);
    }

    private fallback(): void {
        this.fourTickState = 'native';
        if (this.target) void this.target.interact('Lure');
        this.setStatus('fallback Lure');
    }

    private rawFish(): number {
        return Inventory.items()
            .filter(i => /^Raw (trout|salmon)$/i.test(i.name ?? ''))
            .reduce((n, i) => n + i.count, 0);
    }

    private carrierLog() {
        return Inventory.items().find(i => isFletchableLogName(i.name)) ?? null;
    }

    private findSpot(): Target | null {
        return Npcs.query().name('Fishing spot').action('Lure').nearest() as Target | null;
    }

    private async ensureKit(): Promise<boolean> {
        if (!(await this.ensureAxe())) return false;
        if (!(await this.ensureKnife())) return false;
        if (!(await this.ensureLog())) return false;
        return true;
    }

    private async ensureAxe(): Promise<boolean> {
        if (AXE_NAMES.some(n => Inventory.count(n) > 0 || Equipment.contains(n))) return true;
        const ground = GroundItems.query().name(...AXE_NAMES).within(12).nearest();
        if (ground) {
            this.setStatus('taking an axe');
            await ground.interact('Take');
            await Execution.delayUntilTicks(() => AXE_NAMES.some(n => Inventory.count(n) > 0), 6);
            if (AXE_NAMES.some(n => Inventory.count(n) > 0)) return true;
        }
        await Traversal.walkResilient(AXE_SPAWN, { radius: 2, attempts: 4, timeoutMs: 120_000, log: m => this.log(m) });
        const spawn = GroundItems.query().name(...AXE_NAMES).within(8).nearest();
        if (!spawn) {
            this.setStatus('no axe spawn — stopping');
            this.requestFinish('Seers3tFisher: no axe and no axe spawn');
            return false;
        }
        await spawn.interact('Take');
        await Execution.delayUntilTicks(() => AXE_NAMES.some(n => Inventory.count(n) > 0), 6);
        return AXE_NAMES.some(n => Inventory.count(n) > 0);
    }

    private async ensureKnife(): Promise<boolean> {
        if (Inventory.count(KNIFE) > 0 || Equipment.contains(KNIFE)) return true;
        const ground = GroundItems.query().name(KNIFE).within(12).nearest();
        if (ground) {
            this.setStatus('taking a knife');
            await ground.interact('Take');
            await Execution.delayUntilTicks(() => Inventory.count(KNIFE) > 0, 6);
            if (Inventory.count(KNIFE) > 0) return true;
        }
        await Traversal.walkResilient(KNIFE_SPAWN, { radius: 2, attempts: 4, timeoutMs: 120_000, log: m => this.log(m) });
        const spawn = GroundItems.query().name(KNIFE).within(8).nearest();
        if (!spawn) {
            this.setStatus('no knife spawn — stopping');
            this.requestFinish('Seers3tFisher: no knife and no knife spawn');
            return false;
        }
        await spawn.interact('Take');
        await Execution.delayUntilTicks(() => Inventory.count(KNIFE) > 0, 6);
        return Inventory.count(KNIFE) > 0;
    }

    private async ensureLog(): Promise<boolean> {
        if (this.carrierLog()) return true;
        let tree = Locs.query().name('Tree', 'Oak', 'Willow').action('Chop down').nearest();
        if (!tree) {
            await Traversal.walkResilient(TREE_AREA, { radius: 8, attempts: 3, timeoutMs: 90_000, log: m => this.log(m) });
            tree = Locs.query().name('Tree', 'Oak', 'Willow').action('Chop down').nearest();
        }
        if (!tree) {
            this.setStatus('no tree for a carrier log');
            this.requestFinish('Seers3tFisher: no tree for a carrier log');
            return false;
        }
        this.setStatus('chopping one carrier log');
        await Traversal.walkTo(tree.tile(), { radius: 2, timeoutMs: 30_000, log: m => this.log(m) });
        await tree.interact('Chop down');
        if (!(await Execution.delayUntilTicks(() => this.carrierLog() !== null, 20))) {
            this.setStatus('carrier log did not arrive');
            return false;
        }
        return true;
    }

    private async ensureSupplies(): Promise<boolean> {
        const haveRod = Inventory.count('Fly fishing rod') > 0;
        const feathers = Inventory.count('Feather');
        if (haveRod && feathers > 100) return true;
        this.setStatus('banking for rod/feathers');
        await Traversal.walkResilient(BANK, { radius: 2, attempts: 4, timeoutMs: 120_000, log: m => this.log(m) });
        if (!(await Bank.openBooth(BANK, 'Bank booth', 'Use-quickly', m => this.log(m)))) return false;
        if (!(await Bank.waitReady(4000, m => this.log(m)))) return false;
        if (!haveRod) await Bank.withdrawX('Fly fishing rod', 1);
        const want = Math.max(0, this.settings.num('feathers', 10_000) - Inventory.count('Feather'));
        if (want > 0) await Bank.withdrawX('Feather', want);
        await Bank.close();
        return Inventory.count('Fly fishing rod') > 0 && Inventory.count('Feather') > 0;
    }

    private setStatus(s: string): void {
        if (s !== this.status) this.log(s);
        this.status = s;
    }

    override onPaint(ctx: CanvasRenderingContext2D): void {
        const { frame: p, page, section } = scriptFrame(ctx, {
            script: 'Seers3tFisher',
            status: this.status,
            pages: ['Statistics', 'Options'],
            sections: ['Overview', 'Levels'],
            accent: '#8ab4f8',
            byline: 'Fishing',
            key: 'seers3t'
        });
        const mins = (Date.now() - this.startedAt) / 60_000;
        const gains = this.xp.progress();
        const fishing = gains.find(g => g.skill === 'fishing');
        const gained = fishing?.gained ?? 0;
        const xph = mins > 0.5 ? Math.round(gained / mins * 60) : 0;
        const fishPh = mins > 0.5 ? Math.round(this.fishCaught / mins * 60) : 0;

        if (page === 'Options') {
            p.statGrid([
                [{ text: 'Spot: Seers fly fishing' }, { text: `Phase: ${this.fourTickState}` }],
                [{ text: `Knife: ${Inventory.count('Knife')}` }, { text: `Axe: ${this.axeLabel()}` }],
                [{ text: `Carrier logs: ${Inventory.items().filter(i => isFletchableLogName(i.name)).length}` }, { text: `Feathers: ${Inventory.count('Feather').toLocaleString()}` }],
                [{ text: `Drop fish: ${this.settings.bool('dropFish', true) ? 'on' : 'off'}` }, { text: 'Tick: knife + shortbow' }]
            ]);
        } else if (section === 'Levels') {
            paintLevels(p, gains, mins, 3, 'no fishing xp yet');
        } else {
            p.statGrid([
                [{ text: `Runtime: ${fmtDuration(mins)}` }, { text: `Fishing: ${Skills.level('fishing')}` }],
                [{ text: `XP: ${gained.toLocaleString()}` }, { text: `XP/hr: ${xph.toLocaleString()}` }],
                [{ text: `Fish: ${this.fishCaught}` }, { text: `Fish/hr: ${fishPh.toLocaleString()}` }],
                [{ text: `Gaps: ${this.rollGaps.slice(-6).join(',') || '—'}` }, { text: `Phase: ${this.fourTickState}` }],
                [{ text: `Pack: ${Inventory.used()}/28` }, { text: `Carrier: ${Inventory.items().filter(i => isFletchableLogName(i.name)).length} Logs` }]
            ]);
        }
        p.gap();
        ScriptRunner.paintControls(p);
        p.end();
    }

    private axeLabel(): string {
        return AXE_NAMES.find(name => Inventory.count(name) > 0 || Equipment.contains(name)) ?? 'missing';
    }

}
