import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Task } from '#/bot/api/bot/Bot.js';
import { Execution } from '#/bot/api/execution/Execution.js';
import { Game } from '#/bot/api/game/Game.js';
import { Skills } from '#/bot/api/skills/Skills.js';
import { reader, type NpcSnapshot } from '#/bot/adapter/ClientAdapter.js';
import Tile from '#/bot/geometry/Tile.js';
import { SettingsBag } from '#/bot/runtime/Settings.js';
import WanderFighter from '#/bot/scripts/WanderFighter/WanderFighter.js';
import { stubProps } from '../../lib/stubSingletons.js';

class Fighter extends WanderFighter {
    registered: Task[] = [];

    protected override add(...tasks: Task[]): void {
        this.registered.push(...tasks);
    }
}

const here = new Tile(3200, 3200);
const SELF_FACE = 32768 + 1;
const OTHER_PLAYER_FACE = 32768 + 2;

let npcs: NpcSnapshot[];
let inCombat: boolean;
let bot: Fighter;
let restores: (() => void)[];

function guard(index: number, options: { level?: number; inCombat?: boolean; face?: number; name?: string } = {}): NpcSnapshot {
    return {
        index,
        id: 9,
        name: options.name ?? 'Guard',
        anim: -1,
        level: options.level ?? 20,
        size: 1,
        tile: { x: here.x + index, z: here.z, level: 0 },
        distance: index,
        ops: ['Attack'],
        inCombat: options.inCombat ?? false,
        health: 10,
        totalHealth: 20,
        faceEntity: options.face ?? -1
    };
}

const task = (name: string): Task => bot.registered.find(entry => entry.constructor.name === name)!;

function setNpcs(monsters: NpcSnapshot[]): void {
    npcs = monsters;
    bot.invalidateTargets();
}

beforeEach(async () => {
    npcs = [];
    inCombat = false;
    restores = [
        stubProps(reader, {
            npcs: () => npcs,
            combatLevel: () => 100,
            selfSlot: () => 1,
            worldTile: () => here,
            toLocal: () => null
        }),
        stubProps(Game, {
            tile: () => here,
            ingame: () => true,
            inCombat: () => inCombat,
            combatMode: () => 1,
            combatStyleResolution: style => ({ requested: style, effective: style, mode: 1 })
        }),
        stubProps(Skills, {
            level: skill => ({ attack: 10, strength: 20, defence: 30, hitpoints: 40 })[skill] ?? 1,
            xp: () => 0,
            effective: () => 40,
            hpFraction: () => 1
        }),
        stubProps(Execution, {
            delayUntil: async check => check(),
            delayTicks: async () => {}
        })
    ];
    bot = new Fighter();
    bot.bindLog(() => {});
    bot.settings = new SettingsBag({});
    await bot.onStart();
});

afterEach(() => {
    bot.disposeSubscriptions();
    for (const restore of restores.reverse()) {
        restore();
    }
});

test('wanders until two free monsters are nearby', () => {
    setNpcs([guard(1)]);

    expect(task('Fight').validate()).toBe(false);
    expect(task('Wander').validate()).toBe(true);

    setNpcs([guard(1), guard(2)]);

    expect(task('Fight').validate()).toBe(true);
    expect(task('Wander').validate()).toBe(false);
});

test('monsters already fighting someone else do not count as free', () => {
    setNpcs([
        guard(1, { inCombat: true }),
        guard(2, { inCombat: true }),
        guard(3, { inCombat: true })
    ]);

    expect(bot.freeTargetCount()).toBe(0);
    expect(task('Fight').validate()).toBe(false);
    expect(task('Wander').validate()).toBe(true);
});

test('a monster facing another player is excluded even when it is idle', () => {
    setNpcs([guard(1, { face: OTHER_PLAYER_FACE }), guard(2)]);

    expect(bot.freeTargetCount()).toBe(1);
    expect(task('Fight').validate()).toBe(false);
});

test('a monster attacking us is fought below the free-monster threshold', () => {
    setNpcs([guard(1, { level: 80, inCombat: true, face: SELF_FACE })]);

    expect(bot.freeTargetCount()).toBe(1);
    expect(task('Fight').validate()).toBe(true);
    expect(task('Wander').validate()).toBe(false);
});

test('dead monsters above the threshold are not attacked unless they attack us', () => {
    setNpcs([guard(1, { level: 80 }), guard(2, { level: 80 }), guard(3, { level: 80 })]);

    expect(bot.freeTargetCount()).toBe(0);
    expect(task('Fight').validate()).toBe(false);
});

test('banned monsters are ignored even when they are weak and free', () => {
    setNpcs([
        guard(1, { name: 'Rat' }),
        guard(2, { name: 'Duck' }),
        guard(3, { name: 'Spider' }),
        guard(4, { name: 'Giant rat' })
    ]);

    expect(bot.freeTargetCount()).toBe(1);
    expect(task('Fight').validate()).toBe(false);
});

test('death clears the fight and waits for a respawn before continuing', async () => {
    bot.noteDeath(here);
    expect(bot.hasDied()).toBe(true);
    expect(task('Respawn').validate()).toBe(true);

    await task('Respawn').execute();

    expect(bot.hasDied()).toBe(false);
});
