import type { Task } from '../../api/bot/Bot.js';
import { ChatDialog } from '../../api/ui/dialogue/ChatDialog.js';
import { Execution } from '../../api/execution/Execution.js';
import { EventSignal } from '../../api/execution/EventSignal.js';
import { Game } from '../../api/game/Game.js';
import { Reach } from '../../api/walking/Reach.js';
import type { WorldTile } from '../../adapter/ClientAdapter.js';
import { pickWanderTile } from './WanderFighterLogic.js';
import type WanderFighter from './WanderFighter.js';

const DEATH_RE = /oh dear.*you are dead/i;
const WANDER_LEG_TILES = 10;
const WANDER_LEG_TIMEOUT_MS = 30_000;

export class Respawn implements Task {
    readonly label = 'Respawn';

    constructor(private readonly bot: WanderFighter) {
        bot.on('chat.message', e => {
            if (DEATH_RE.test(e.text)) {
                bot.noteDeath(Game.tile());
            }
        });
    }

    validate(): boolean {
        return this.bot.hasDied();
    }

    async execute(): Promise<void> {
        this.bot.setStatus('died — waiting to respawn');
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 30_000);
        await Execution.delayTicks(3);
        this.bot.noteRespawn(Game.tile());
    }
}

export class EnableAutoRetaliate implements Task {
    readonly label = 'Enable auto retaliate';

    constructor(private readonly bot: WanderFighter) {}

    validate(): boolean {
        return !Game.autoRetaliateOn();
    }

    async execute(): Promise<void> {
        this.bot.setStatus('enabling auto retaliate');
        await Game.openSideTab(0);
        for (let i = 0; i < 5 && !Game.autoRetaliateOn(); i++) {
            Game.setAutoRetaliate(true);
            if (await Execution.delayUntil(() => Game.autoRetaliateOn(), 1500)) {
                break;
            }
        }
        if (!Game.autoRetaliateOn()) {
            throw new Error('[WanderFighter] could not enable Auto Retaliate');
        }
        this.bot.log('Auto Retaliate on');
    }
}

export class SetTrainingStyle implements Task {
    readonly label = 'Set training style';
    private lastWarnAt = 0;

    constructor(private readonly bot: WanderFighter) {}

    validate(): boolean {
        return !this.bot.styleSelected();
    }

    async execute(): Promise<void> {
        const style = this.bot.desiredStyle();
        if (!this.bot.styleReady()) {
            this.bot.setStatus(`equip a weapon with ${style} style`);
            this.warn(
                `the current weapon offers no exact ${style} style — refusing to train another stat; equip a weapon with `
                + 'Attack, Strength and Defensive modes'
            );
            await Execution.delayTicks(1);
            return;
        }

        this.bot.setStatus(`setting ${style} style`);
        Game.setCombatStyle(style);
        if (await Execution.delayUntil(() => this.bot.styleSelected(), 3000)) {
            this.bot.log(`combat style set to ${style} (Attack ${this.bot.levelOf('attack')}, Strength ${this.bot.levelOf('strength')}, Defence ${this.bot.levelOf('defence')})`);
        } else {
            this.warn(`could not set the ${style} style (combat tab not ready?) — retrying`);
        }
    }

    private warn(message: string): void {
        const now = Date.now();
        if (now < this.lastWarnAt) {
            return;
        }
        this.lastWarnAt = now + 30_000;
        this.bot.log(message);
    }
}

export class Fight implements Task {
    readonly label = 'Fight';

    constructor(private readonly bot: WanderFighter) {}

    validate(): boolean {
        if (!this.bot.styleSelected()) {
            return false;
        }
        // Why: a held execute() owns the whole fight, so in-combat validation only
        // matters when an interruption left a monster facing us between loops.
        if (Game.inCombat()) {
            return this.bot.incomingTarget() !== null;
        }
        return this.bot.canStartFight();
    }

    async execute(): Promise<void> {
        const target = this.bot.findTarget();
        if (!target) {
            return;
        }

        this.bot.beginFight();
        this.bot.setStatus(`attacking ${target.name ?? 'monster'} at ${target.tile()}`);
        const status = await Reach.entityOp({
            find: () => this.bot.track(target),
            op: 'Attack',
            expect: () => Game.inCombat() || ChatDialog.canContinue(),
            // Why: a wandering target postpones the server's can't-reach verdict forever.
            openWhenUnreachable: true,
            expectMs: 5000,
            what: target.name ?? undefined,
            log: message => this.bot.log(message)
        });
        if (status !== 'done' || ChatDialog.canContinue()) {
            if (status !== 'done' && !EventSignal.pending() && !ChatDialog.canContinue() && !this.bot.hasDied()) {
                this.bot.skip(target, status);
            }
            this.bot.cancelFight();
            return;
        }

        this.bot.setStatus('fighting');
        const deadline = performance.now() + 90_000;
        while (performance.now() < deadline) {
            if (EventSignal.pending() || ChatDialog.canContinue() || this.bot.hasDied()) {
                this.bot.cancelFight();
                return;
            }
            const current = this.bot.track(target);
            if (!current || (current.health === 0 && current.snap.totalHealth > 0)) {
                if (current) {
                    await Execution.delayUntil(() => this.bot.track(target) === null, 10_000);
                }
                await this.bot.recordKill(target);
                await Execution.delayTicks(2);
                return;
            }
            if (!Game.inCombat() && !current.inCombat) {
                this.bot.cancelFight();
                return;
            }
            await Execution.delayTicks(2);
        }
        this.bot.cancelFight();
    }
}

export class Wander implements Task {
    readonly label = 'Wander';

    constructor(private readonly bot: WanderFighter) {}

    validate(): boolean {
        return !Game.inCombat()
            && this.bot.styleSelected()
            && this.bot.incomingTarget() === null
            && this.bot.freeTargetCount() < this.bot.minFreeTargets();
    }

    async execute(): Promise<void> {
        const start: WorldTile | null = Game.tile();
        if (!start) {
            return;
        }

        const budget = this.bot.wanderDistance();
        let from: WorldTile = start;
        let travelled = 0;
        let spotted = false;
        this.bot.log(
            `wandering up to ${budget} tiles — ${this.bot.freeTargetCount()}/${this.bot.minFreeTargets()} free monsters nearby`
        );

        // Why: walk in short legs so a monster that comes into range stops the wander instead of
        // being missed until the whole trip finishes.
        while (travelled < budget) {
            if (this.bot.canStartFight()) {
                spotted = true;
                break;
            }

            const leg = Math.min(WANDER_LEG_TILES, budget - travelled);
            const target = await this.pickLeg(from, leg);
            if (!target) {
                this.bot.log('no reachable wander target — trying again');
                break;
            }

            this.bot.setStatus(`wandering to ${target} (${travelled}/${budget} tiles)`);
            const arrived = await this.bot.walkWanderTarget(target, WANDER_LEG_TIMEOUT_MS);
            const reached: WorldTile = Game.tile() ?? from;
            const moved = Math.max(Math.abs(reached.x - from.x), Math.abs(reached.z - from.z));
            travelled += moved;
            this.bot.noteWanderLeg(from, reached);
            from = reached;

            if (!arrived) {
                this.bot.log(`wander to ${target} did not complete after ${moved} tiles`);
                break;
            }
            if (moved === 0) {
                this.bot.log('wander made no progress — trying a new direction');
                break;
            }
            if (this.bot.canStartFight()) {
                spotted = true;
                break;
            }
        }

        this.bot.noteWander(start, from);
        if (spotted) {
            this.bot.log(
                `spotted ${this.bot.freeTargetCount()} free monsters while wandering after ${travelled} tiles — stopping to fight`
            );
        } else {
            this.bot.log(`wandered ${travelled} tiles to ${from}`);
        }
    }

    private async pickLeg(from: WorldTile, distance: number): Promise<WorldTile | null> {
        for (let attempt = 0; attempt < 6; attempt++) {
            const candidate = pickWanderTile(
                from,
                distance,
                tile => (attempt === 0 || tile.level === from.level) && this.bot.canWanderTo(tile),
                Math.random,
                this.bot.wanderDirection()
            );
            if (candidate && await this.bot.canWalkAnywhere(candidate)) {
                return candidate;
            }
        }
        return null;
    }
}
