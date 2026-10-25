import type { CombatStyleResolution, MeleeCombatStyle } from '../../api/combat/CombatStyle.js';
import Tile from '../../geometry/Tile.js';
import type { WorldTile } from '../../adapter/ClientAdapter.js';

/** The three stats this bot keeps level. */
export type TrainingStyle = Extract<MeleeCombatStyle, 'attack' | 'strength' | 'defence'>;

export const DEFAULT_WANDER_DISTANCE = 60;
export const DEFAULT_SEARCH_RADIUS = 30;
export const DEFAULT_MIN_FREE_TARGETS = 2;
export const DEFAULT_AVOID_MONSTERS: readonly string[] = ['Rat', 'Duck', 'Spider'];

/** Exact, case-insensitive name match: "Rat" is avoided, "Giant rat" is not. */
export function isBannedMonster(name: string | null | undefined, banned: readonly string[]): boolean {
    if (!name) {
        return false;
    }
    const normalized = name.trim().toLowerCase();
    if (normalized.length === 0) {
        return false;
    }
    return banned.some(entry => entry.trim().toLowerCase() === normalized);
}


export interface MonsterView {
    level: number;
    inCombat: boolean;
    targetsMe: boolean;
    targetsAnotherPlayer: boolean;
    distance: number;
}

/** Strictly below half the player's combat level; level 0 is never a monster. */
export function fightsBelowHalf(level: number, combatLevel: number): boolean {
    return level > 0 && combatLevel > 0 && level * 2 < combatLevel;
}

/**
 * AutoFighter's engagement rule plus the below-half level gate.
 * Why: a monster already facing us is fought whatever its level, since auto-retaliate
 * would drag us into that fight regardless; otherwise only free, weak monsters start one.
 */
export function eligibleTarget(monster: MonsterView, combatLevel: number, searchRadius: number): boolean {
    if (monster.distance > searchRadius || monster.targetsAnotherPlayer) {
        return false;
    }
    if (monster.targetsMe) {
        return true;
    }
    return !monster.inCombat && fightsBelowHalf(monster.level, combatLevel);
}

/** Stop wandering only once the area has enough free monsters, or something is already on us. */
export function shouldStartFight(freeTargets: number, minFreeTargets: number, incoming: boolean): boolean {
    return incoming || freeTargets >= minFreeTargets;
}

/** Train the lowest of the three melee stats, so they stay level; ties go Attack, then Strength. */
export function lowestMeleeStyle(attack: number, strength: number, defence: number): TrainingStyle {
    if (attack <= strength && attack <= defence) {
        return 'attack';
    }
    return strength <= defence ? 'strength' : 'defence';
}

/** Fail closed: never accept a fallback that would train a different stat. */
export function exactTrainingMode(style: TrainingStyle, resolution: CombatStyleResolution | null): number | null {
    return resolution?.effective === style ? resolution.mode : null;
}

/** Eight compass directions, starting north and going clockwise. */
export const WANDER_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
    [0, -1], [1, -1], [1, 0], [1, 1],
    [0, 1], [-1, 1], [-1, 0], [-1, -1]
];

function shuffledDirections(rand: () => number): Array<readonly [number, number]> {
    const dirs = [...WANDER_DIRECTIONS];
    for (let i = dirs.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [dirs[i], dirs[j]] = [dirs[j]!, dirs[i]!];
    }
    return dirs;
}

/** Prefer the full hop, then shorter hops, and never return a tile the caller cannot navigate to. */
export function pickWanderTile(
    here: WorldTile,
    distance: number,
    navigable: (tile: Tile) => boolean,
    rand: () => number = Math.random,
    avoidDirection: readonly [number, number] | null = null
): Tile | null {
    if (here.level > 0) {
        const down = new Tile(here.x, here.z, here.level - 1);
        if (navigable(down)) {
            return down;
        }
    }
    const distances = [...new Set([distance, Math.max(1, Math.floor(distance / 2)), 5])];
    const directions = shuffledDirections(rand);
    const forward = avoidDirection
        ? directions.filter(([dx, dz]) => dx * avoidDirection[0] + dz * avoidDirection[1] >= 0)
        : directions;
    // Try forward/sideways first, then allow a backwards hop if that is all the map offers.
    for (const pass of forward === directions ? [directions] : [forward, directions]) {
        for (const steps of distances) {
            for (const [dx, dz] of pass) {
                const tile = new Tile(here.x + dx * steps, here.z + dz * steps, here.level);
                if (navigable(tile)) {
                    return tile;
                }
            }
        }
    }
    return null;
}
