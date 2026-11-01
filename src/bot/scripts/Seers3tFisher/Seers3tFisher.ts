import { actions, reader } from '../../adapter/ClientAdapter.js';
import { LoopingBot } from '../../api/bot/Bot.js';
import { Equipment } from '../../api/equipment/Equipment.js';
import { Execution } from '../../api/execution/Execution.js';
import { Game } from '../../api/game/Game.js';
import { Inventory } from '../../api/inventory/Inventory.js';
import { Npcs } from '../../api/npcs/Npcs.js';
import { Skills } from '../../api/skills/Skills.js';
import { ChatDialog } from '../../api/ui/dialogue/ChatDialog.js';
import { Traversal } from '../../api/walking/Traversal.js';
import Tile from '../../geometry/Tile.js';
import { Input } from '../../input/Input.js';
import { paintLevels, scriptFrame, XpTracker } from '../../paint/jive.js';
import { fmtDuration } from '../../paint/paintLogic.js';
import { BotHost } from '../../runtime/BotHost.js';
import { ScriptRunner } from '../../runtime/ScriptRunner.js';
import type { SettingsSchema } from '../../runtime/Settings.js';
import { isFletchableLogName } from '../GatheringBot/TickManipLogic.js';
import { Seers3tProvisioner } from './Seers3tProvisioner.js';

const SPOT = new Tile(2716, 3532, 0);
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
    private fourTickState: 'native' | 'running' = 'native';
    private fourTickLastSerial = -1;
    private sentTick = -1;
    private awaitingLanding = false;
    private nextSendTick = -1;
    private aim = 0;
    private late: number[] = [];
    private lastAim = -1;
    private lastRollTick = -1;
    private lastCatchTick = -1;
    private lastRaw = 0;
    private stopTick: (() => void) | null = null;
    private status = 'starting';
    private startedAt = Date.now();
    private fishCaught = 0;
    private rollGaps: number[] = [];
    private readonly xp = new XpTracker(['fishing'], Skills);
    private provisioner!: Seers3tProvisioner;
    private provisioned = false;

    override async onStart(): Promise<void> {
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 0);
        this.startedAt = Date.now();
        this.provisioner = new Seers3tProvisioner({
            log: message => this.log(message),
            setStatus: message => this.setStatus(message),
            finish: reason => this.requestFinish(reason),
            feathers: () => this.settings.num('feathers', 10_000)
        });
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
        if (!this.provisioned || Inventory.count(KNIFE) < 1 || !this.carrierLog()) {
            this.provisioned = false;
            if (!(await this.provisioner.ensureAll())) return;
            this.provisioned = true;
        }
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
            if (fresh && state.seq === ROLL_ANIM) {
                this.sendBatch(tick);
                this.fourTickState = 'running';
            }
            return;
        }
        if (this.awaitingLanding) {
            if (fresh && state.seq === FLETCH_ANIM) {
                const late = tick - this.sentTick - 1;
                if (late >= 0 && late <= 3) {
                    this.late.push(late);
                    if (this.late.length > 6) this.late.shift();
                    const aim = this.mode(this.late);
                    if (aim !== this.lastAim) {
                        this.lastAim = aim;
                        this.log(`3t aim=${aim} lateness=[${this.late.join(',')}]`);
                    }
                    this.aim = aim;
                }
                this.awaitingLanding = false;
                this.nextSendTick = tick + 2 - this.aim;
            } else if (tick - this.sentTick > 4) {
                this.fallback();
            }
            return;
        }
        if (this.nextSendTick >= 0 && tick >= this.nextSendTick) {
            if (this.lastCatchTick >= 0 && tick - this.lastCatchTick > 12) {
                this.fallback();
                return;
            }
            this.sendBatch(tick);
        }
    }

    private mode(values: readonly number[]): number {
        const counts = new Map<number, number>();
        for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
        let best = 0;
        let bestCount = -1;
        for (const [value, count] of counts) {
            if (count > bestCount) { best = value; bestCount = count; }
        }
        return best;
    }

    private sendBatch(tick: number): void {
        if (!this.target) return;
        const knife = Inventory.first(KNIFE);
        const log = this.carrierLog();
        if (!knife || !log || ChatDialog.isMakeMenu()) {
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
        this.rollGaps.push(this.sentTick >= 0 ? tick - this.sentTick : 0);
        this.sentTick = tick;
        this.awaitingLanding = true;
        this.nextSendTick = -1;
        this.lastRollTick = tick;
        this.setStatus(`3-tick batch @${tick}`);
    }

    private fallback(): void {
        this.fourTickState = 'native';
        this.awaitingLanding = false;
        this.nextSendTick = -1;
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
