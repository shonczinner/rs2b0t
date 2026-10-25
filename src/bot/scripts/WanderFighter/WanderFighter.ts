import { TaskBot } from '../../api/bot/Bot.js';
import { Execution } from '../../api/execution/Execution.js';
import { Game } from '../../api/game/Game.js';
import { Npcs, type Npc } from '../../api/npcs/Npcs.js';
import { ContinueDialog } from '../../api/tasks/ContinueDialog.js';
import { Skills } from '../../api/skills/Skills.js';
import { Traversal } from '../../api/walking/Traversal.js';
import { Navigator } from '../../event/webwalk/Navigator.js';
import { Reachability } from '../../event/webwalk/geometry/Reachability.js';
import { Paint } from '../../paint/Paint.js';
import { fmtDuration, fmtXpHr, paintSkillShort } from '../../paint/paintLogic.js';
import { ScriptRunner } from '../../runtime/ScriptRunner.js';
import type { SettingsSchema } from '../../runtime/Settings.js';
import { reader } from '../../adapter/ClientAdapter.js';
import type { WorldTile } from '../../adapter/ClientAdapter.js';
import Tile from '../../geometry/Tile.js';
import {
    DEFAULT_MIN_FREE_TARGETS,
    DEFAULT_SEARCH_RADIUS,
    DEFAULT_WANDER_DISTANCE,
    DEFAULT_AVOID_MONSTERS,
    eligibleTarget,
    exactTrainingMode,
    isBannedMonster,
    lowestMeleeStyle,
    shouldStartFight,
    type TrainingStyle
} from './WanderFighterLogic.js';
import {
    EnableAutoRetaliate,
    Fight,
    Respawn,
    SetTrainingStyle,
    Wander
} from './WanderFighterTasks.js';

const COMBAT_SKILLS: readonly string[] = ['attack', 'strength', 'defence', 'hitpoints'];
const PROGRESS_INTERVAL_MS = 5 * 60_000;
const TARGET_CACHE_MS = 200;

export const SETTINGS: SettingsSchema = {
    wanderDistance: {
        type: 'number',
        default: DEFAULT_WANDER_DISTANCE,
        min: 5,
        max: 60,
        label: 'Wander distance (tiles)',
        group: 'Wandering',
        help: 'how far each idle hop reaches; walk further to leave a crowded area sooner'
    },
    searchRadius: {
        type: 'number',
        default: DEFAULT_SEARCH_RADIUS,
        min: 5,
        max: 30,
        label: 'Monster search radius (tiles)',
        group: 'Fighting',
        help: 'monsters outside this radius do not count as nearby, so the bot keeps wandering'
    },
    minFreeTargets: {
        type: 'number',
        default: DEFAULT_MIN_FREE_TARGETS,
        min: 1,
        max: 10,
        label: 'Free monsters before fighting',
        group: 'Fighting',
        help: 'keep wandering until this many below-half monsters are in range and not already engaged; 1 fights lone monsters'
    },
    avoidMonsters: {
        type: 'string[]',
        default: [...DEFAULT_AVOID_MONSTERS],
        label: 'Monsters to avoid',
        group: 'Fighting',
        help: 'exact monster names, matched case-insensitively; "Rat" avoids rats but leaves "Giant rat" alone'
    }
};

export default class WanderFighter extends TaskBot {
    override loopDelay = 600;

    private wanderDistanceValue = DEFAULT_WANDER_DISTANCE;
    private searchRadiusValue = DEFAULT_SEARCH_RADIUS;
    private minFreeTargetsValue = DEFAULT_MIN_FREE_TARGETS;
    private avoidMonstersValue: readonly string[] = DEFAULT_AVOID_MONSTERS;
    private status = 'starting';
    private startedAt = Date.now();
    private lastProgressAt = Date.now();
    private xpAtStart = 0;
    private kills = 0;
    private deaths = 0;
    private wanders = 0;
    private died = false;
    private fightXpBefore: Record<string, number> | null = null;
    private lastWanderDir: readonly [number, number] | null = null;
    private readonly skipped = new Map<string, number>();
    private targetCache: Npc[] = [];
    private targetCacheAt = 0;
    private displayedFree = 0;

    override async onStart(): Promise<void> {
        await Execution.delayUntil(() => Game.ingame() && Game.tile() !== null, 0);

        this.wanderDistanceValue = this.settings.num('wanderDistance', DEFAULT_WANDER_DISTANCE);
        this.searchRadiusValue = this.settings.num('searchRadius', DEFAULT_SEARCH_RADIUS);
        this.minFreeTargetsValue = this.settings.num('minFreeTargets', DEFAULT_MIN_FREE_TARGETS);
        this.avoidMonstersValue = this.settings.list('avoidMonsters', [...DEFAULT_AVOID_MONSTERS]);

        const now = Date.now();
        this.startedAt = now;
        this.lastProgressAt = now;
        this.xpAtStart = this.totalCombatXp();

        this.on('skill.level', e => {
            if (!COMBAT_SKILLS.includes(e.name)) {
                return;
            }
            this.log(`level up: ${e.name} ${e.previous} → ${e.level} (combat level ${this.combatLevel()})`);
        });

        this.add(
            new ContinueDialog(),
            new Respawn(this),
            new EnableAutoRetaliate(this),
            new SetTrainingStyle(this),
            new Fight(this),
            new Wander(this)
        );

        const cutoff = this.combatLevel() > 0 ? (this.combatLevel() / 2).toFixed(1) : '?';
        this.log(
            `WanderFighter starting — combat level ${this.combatLevel()} (fights monsters below ${cutoff}), `
            + `${this.statLine()}, ${this.totalCombatXp()} total combat XP, `
            + `training ${this.desiredStyle()} (lowest melee stat), `
            + `wandering ${this.wanderDistanceValue} tiles until ${this.minFreeTargetsValue} free monsters are within ${this.searchRadiusValue}, `
            + `avoiding [${this.avoidMonstersValue.join(', ') || 'nothing'}]`
        );
    }

    override async loop(): Promise<number | void> {
        this.displayedFree = this.freeTargetCount();
        this.logProgress();
        return super.loop();
    }

    override onPaint(ctx: CanvasRenderingContext2D): void {
        const p = Paint.begin(ctx, { dock: 'chatbox', accent: '#d08f5a' });
        const mins = (Date.now() - this.startedAt) / 60_000;
        const xp = this.xpGained();
        p.title(`WanderFighter — ${this.status}`);
        p.row(`Runtime: ${fmtDuration(mins)}`, `Kills: ${this.kills}`, `Deaths: ${this.deaths}`);
        p.row(`XP: ${xp}`, `XP/hr: ${fmtXpHr(xp, mins)}`, `Combat: ${this.combatLevel()}`);
        p.row(`Style: ${this.desiredStyle()}`, `Free: ${this.displayedFree}/${this.minFreeTargetsValue}`, `Wanders: ${this.wanders}`);
        p.bar('HP', Skills.hpFraction());
        p.gap();
        ScriptRunner.paintControls(p);
        p.end();
    }

    combatLevel(): number {
        return reader.combatLevel();
    }

    levelOf(skill: string): number {
        return Skills.level(skill);
    }

    wanderDistance(): number {
        return this.wanderDistanceValue;
    }

    searchRadius(): number {
        return this.searchRadiusValue;
    }

    minFreeTargets(): number {
        return this.minFreeTargetsValue;
    }

    desiredStyle(): TrainingStyle {
        return lowestMeleeStyle(Skills.level('attack'), Skills.level('strength'), Skills.level('defence'));
    }

    /** The exact combat-tab mode that trains {@link desiredStyle}, or null when the weapon cannot. */
    styleMode(): number | null {
        const style = this.desiredStyle();
        return exactTrainingMode(style, Game.combatStyleResolution(style));
    }

    styleReady(): boolean {
        return this.styleMode() !== null;
    }

    styleSelected(): boolean {
        const mode = this.styleMode();
        return mode !== null && Game.combatMode() === mode;
    }

    setStatus(status: string): void {
        this.status = status;
    }

    hasDied(): boolean {
        return this.died;
    }

    noteDeath(tile: WorldTile | null): void {
        if (this.died) {
            return;
        }
        this.died = true;
        this.deaths++;
        this.fightXpBefore = null;
        this.invalidateTargets();
        this.log(`died (#${this.deaths}) at ${tile ? `${tile.x},${tile.z}` : 'an unknown tile'} — waiting to respawn`);
    }

    noteRespawn(tile: WorldTile | null): void {
        this.died = false;
        this.clearSkips();
        this.invalidateTargets();
        this.log(`respawned at ${tile ? `${tile.x},${tile.z}` : 'an unknown tile'} — wandering for monsters`);
    }

    /** Auto-retaliate/self-defence target: anything currently facing us is fair game, whatever the search radius. */
    incomingTarget(): Npc | null {
        return Npcs.query()
            .action('Attack')
            .where(npc => npc.targetsMe() && !this.isAvoided(npc))
            .results()
            .sort((a, b) => a.distance() - b.distance())[0] ?? null;
    }

    canStartFight(): boolean {
        const targets = this.freeTargets();
        return shouldStartFight(targets.length, this.minFreeTargetsValue, this.incomingTarget() !== null);
    }

    findTarget(): Npc | null {
        return this.incomingTarget() ?? this.freeTargets()[0] ?? null;
    }

    freeTargetCount(): number {
        return this.freeTargets().length;
    }

    /** Attackable, weak-or-incoming, free and reachable monsters inside the search radius. */
    freeTargets(): Npc[] {
        const now = Date.now();
        if (now - this.targetCacheAt <= TARGET_CACHE_MS) {
            return this.targetCache;
        }
        const combatLevel = this.combatLevel();
        const radius = this.searchRadiusValue;
        const targets = Npcs.query()
            .action('Attack')
            .within(radius)
            .where(npc => !this.isSkipped(npc))
            .where(npc => !this.isAvoided(npc))
            .where(npc => eligibleTarget({
                level: npc.level,
                inCombat: npc.inCombat,
                targetsMe: npc.targetsMe(),
                targetsAnotherPlayer: npc.targetsAnotherPlayer(),
                distance: npc.distance()
            }, combatLevel, radius))
            .where(npc => this.reachable(npc))
            .results()
            .sort((a, b) => a.distance() - b.distance());
        this.targetCache = targets;
        this.targetCacheAt = now;
        return targets;
    }

    track(npc: Npc): Npc | null {
        return Npcs.all().find(n => n.index === npc.index && n.id === npc.id) ?? null;
    }

    isSkipped(npc: Npc): boolean {
        const key = `${npc.index}:${npc.id}`;
        const until = this.skipped.get(key) ?? 0;
        if (until <= Date.now()) {
            this.skipped.delete(key);
            return false;
        }
        return true;
    }

    /** True when the monster's name is on the configured avoid list. */
    isAvoided(npc: Npc): boolean {
        return isBannedMonster(npc.name, this.avoidMonstersValue);
    }

    avoidMonsters(): readonly string[] {
        return this.avoidMonstersValue;
    }

    skip(npc: Npc, reason: string): void {
        this.skipped.set(`${npc.index}:${npc.id}`, Date.now() + 30_000);
        this.invalidateTargets();
        this.log(`skipping ${npc.name ?? 'monster'} at ${npc.tile()} for 30s (${reason})`);
    }

    clearSkips(): void {
        this.skipped.clear();
    }

    /** Cheap scene-local probe first, then the door-aware scene route. */
    private reachable(npc: Npc): boolean {
        const tile = npc.tile();
        if (!Reachability.probeable(tile)) {
            return true;
        }
        return Reachability.canReach(tile, { maxSteps: 2048, adjacentOk: true });
    }

    beginFight(): void {
        this.fightXpBefore = this.xpSnapshot();
    }

    cancelFight(): void {
        this.fightXpBefore = null;
    }

    async recordKill(npc: Npc): Promise<void> {
        // Why: the server grants combat XP around the death animation, so snapshot after a beat.
        await Execution.delayTicks(2);
        const after = this.xpSnapshot();
        const before = this.fightXpBefore ?? after;
        const gains = COMBAT_SKILLS.map(skill => ({
            skill,
            gained: Math.max(0, (after[skill] ?? 0) - (before[skill] ?? 0))
        }));
        const gained = gains.reduce((sum, entry) => sum + entry.gained, 0);
        this.kills++;
        this.invalidateTargets();
        this.log(
            `kill #${this.kills}: ${npc.name ?? 'monster'} (level ${npc.level}) — +${gained} XP `
            + `(${gains.map(entry => `${paintSkillShort(entry.skill)} +${entry.gained}`).join(', ')}); `
            + `total ${this.totalCombatXp()} XP`
        );
        this.fightXpBefore = null;
        this.logProgress();
    }

    logProgress(force = false): void {
        const now = Date.now();
        if (!force && now - this.lastProgressAt < PROGRESS_INTERVAL_MS) {
            return;
        }
        this.lastProgressAt = now;
        const mins = (now - this.startedAt) / 60_000;
        const xp = this.xpGained();
        this.log(
            `progress: ${this.kills} kills, ${this.deaths} deaths, +${xp} XP (${fmtXpHr(xp, mins)} xp/hr), `
            + `${this.statLine()}, ${fmtDuration(mins)} runtime`
        );
    }

    xpGained(): number {
        return Math.max(0, this.totalCombatXp() - this.xpAtStart);
    }

    private totalCombatXp(): number {
        return COMBAT_SKILLS.reduce((sum, skill) => sum + Skills.xp(skill), 0);
    }

    private xpSnapshot(): Record<string, number> {
        return Object.fromEntries(COMBAT_SKILLS.map(skill => [skill, Skills.xp(skill)]));
    }

    private statLine(): string {
        return COMBAT_SKILLS
            .map(skill => `${paintSkillShort(skill)} ${Skills.level(skill)}`)
            .join(' / ');
    }

    noteWander(from?: WorldTile, to?: WorldTile): void {
        if (from && to && from.level === to.level) {
            const dx = Math.sign(to.x - from.x);
            const dz = Math.sign(to.z - from.z);
            this.lastWanderDir = dx === 0 && dz === 0 ? null : [dx, dz];
        }
        this.wanders++;
        this.invalidateTargets();
    }

    wanderDirection(): readonly [number, number] | null {
        return this.lastWanderDir;
    }

    /** Fast scene-local reach check before asking the webwalk graph. */
    private canWalkTo(tile: Tile): boolean {
        const here = Game.tile();
        if (here === null) {
            return false;
        }
        if (tile.level === here.level
            && Reachability.walkable(tile)
            && Reachability.canReach(tile, { maxSteps: 2048 })) {
            return true;
        }
        return false;
    }

    /** Scene-local reach first (fast), then the webwalk graph so doors and stairs count. */
    async canWalkAnywhere(tile: Tile): Promise<boolean> {
        if (this.canWalkTo(tile)) {
            return true;
        }
        const here = Game.tile();
        if (here === null) {
            return false;
        }
        const path = await Navigator.findPath(here, tile, {
            policy: { useTeleports: false },
            timeoutMs: 5000
        });
        return path.ok;
    }

    canWanderTo(tile: Tile): boolean {
        const here = Game.tile();
        if (here === null) {
            return false;
        }
        if (tile.level === here.level) {
            return true;
        }
        return here.level > 0
            && tile.level === here.level - 1
            && tile.x === here.x
            && tile.z === here.z;
    }

    async walkWanderTarget(target: WorldTile, timeoutMs = 120_000): Promise<boolean> {
        return Traversal.walkResilient(target, {
            radius: 3,
            timeoutMs,
            log: message => this.log(`  ${message}`)
        });
    }

    /** Update the forward direction between wander legs without counting a whole wander. */
    noteWanderLeg(from: WorldTile | null, to: WorldTile | null): void {
        if (from && to && from.level === to.level) {
            const dx = Math.sign(to.x - from.x);
            const dz = Math.sign(to.z - from.z);
            this.lastWanderDir = dx === 0 && dz === 0 ? null : [dx, dz];
        }
        this.invalidateTargets();
    }

    invalidateTargets(): void {
        this.targetCacheAt = 0;
    }
}
