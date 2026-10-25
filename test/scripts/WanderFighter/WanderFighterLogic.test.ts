import { describe, expect, test } from 'bun:test';
import Tile from '#/bot/geometry/Tile.js';
import {
    DEFAULT_AVOID_MONSTERS,
    DEFAULT_MIN_FREE_TARGETS,
    DEFAULT_SEARCH_RADIUS,
    DEFAULT_WANDER_DISTANCE,
    eligibleTarget,
    exactTrainingMode,
    fightsBelowHalf,
    isBannedMonster,
    lowestMeleeStyle,
    pickWanderTile,
    shouldStartFight,
    type MonsterView
} from '#/bot/scripts/WanderFighter/WanderFighterLogic.js';

const here = new Tile(3200, 3200);

function monster(overrides: Partial<MonsterView> = {}): MonsterView {
    return {
        level: 10,
        inCombat: false,
        targetsMe: false,
        targetsAnotherPlayer: false,
        distance: 3,
        ...overrides
    };
}

describe('below-half targets', () => {
    test('is strict: exactly half the combat level is not below half', () => {
        expect(fightsBelowHalf(20, 42)).toBe(true);
        expect(fightsBelowHalf(21, 42)).toBe(false);
        expect(fightsBelowHalf(22, 42)).toBe(false);
    });

    test('ignores level 0 NPCs and an unknown player combat level', () => {
        expect(fightsBelowHalf(0, 42)).toBe(false);
        expect(fightsBelowHalf(1, 0)).toBe(false);
    });
});

describe('eligible monsters', () => {
    test('accepts free weak monsters inside the search radius', () => {
        expect(eligibleTarget(monster(), 42, 15)).toBe(true);
    });

    test('rejects monsters outside the radius, already fighting another player, or in combat', () => {
        expect(eligibleTarget(monster({ distance: 16 }), 42, 15)).toBe(false);
        expect(eligibleTarget(monster({ targetsAnotherPlayer: true }), 42, 15)).toBe(false);
        expect(eligibleTarget(monster({ inCombat: true }), 42, 15)).toBe(false);
    });

    test('accepts a monster attacking us even when it is above the threshold', () => {
        expect(eligibleTarget(monster({ level: 80, inCombat: true, targetsMe: true }), 42, 15)).toBe(true);
    });

    test('a monster attacking another player is never ours, even if it also faces us', () => {
        expect(eligibleTarget(monster({ targetsMe: true, targetsAnotherPlayer: true }), 42, 15)).toBe(false);
    });
});

describe('avoid list', () => {
    test('banned names match exactly and case-insensitively', () => {
        expect(isBannedMonster('Rat', DEFAULT_AVOID_MONSTERS)).toBe(true);
        expect(isBannedMonster('rat', DEFAULT_AVOID_MONSTERS)).toBe(true);
        expect(isBannedMonster('duck', DEFAULT_AVOID_MONSTERS)).toBe(true);
        expect(isBannedMonster('Spider', DEFAULT_AVOID_MONSTERS)).toBe(true);
    });

    test('does not ban names that merely contain a banned word', () => {
        expect(isBannedMonster('Giant rat', DEFAULT_AVOID_MONSTERS)).toBe(false);
        expect(isBannedMonster('Pirate', DEFAULT_AVOID_MONSTERS)).toBe(false);
        expect(isBannedMonster('Rat catcher', DEFAULT_AVOID_MONSTERS)).toBe(false);
    });

    test('handles an empty name or an empty list', () => {
        expect(isBannedMonster(null, DEFAULT_AVOID_MONSTERS)).toBe(false);
        expect(isBannedMonster('Rat', [])).toBe(false);
    });
});

describe('wander threshold', () => {
    test('defaults to 60-tile wanders, a 30-tile search radius and two free monsters', () => {
        expect(DEFAULT_WANDER_DISTANCE).toBe(60);
        expect(DEFAULT_SEARCH_RADIUS).toBe(30);
        expect(DEFAULT_MIN_FREE_TARGETS).toBe(2);
    });

    test('keeps wandering below the free-monster threshold', () => {
        expect(shouldStartFight(2, 3, false)).toBe(false);
        expect(shouldStartFight(3, 3, false)).toBe(true);
        expect(shouldStartFight(0, 1, false)).toBe(false);
        expect(shouldStartFight(1, 1, false)).toBe(true);
    });

    test('an incoming attacker stops wandering below the threshold', () => {
        expect(shouldStartFight(1, 3, true)).toBe(true);
    });
});

describe('lowest melee stat', () => {
    test('trains the lowest of Attack, Strength and Defence', () => {
        expect(lowestMeleeStyle(10, 20, 30)).toBe('attack');
        expect(lowestMeleeStyle(20, 10, 30)).toBe('strength');
        expect(lowestMeleeStyle(20, 30, 10)).toBe('defence');
    });

    test('breaks ties Attack, then Strength, then Defence', () => {
        expect(lowestMeleeStyle(10, 10, 10)).toBe('attack');
        expect(lowestMeleeStyle(20, 10, 10)).toBe('strength');
        expect(lowestMeleeStyle(20, 20, 10)).toBe('defence');
    });
});

describe('exact training style', () => {
    test('accepts only the mode that trains the requested stat', () => {
        const resolution = { requested: 'defence' as const, effective: 'defence' as const, mode: 3 };
        expect(exactTrainingMode('defence', resolution)).toBe(3);
        expect(exactTrainingMode('attack', resolution)).toBeNull();
        expect(exactTrainingMode('strength', null)).toBeNull();
    });
});

describe('wander targets', () => {
    test('prefers a navigable full-distance hop', () => {
        let checked = 0;
        const target = pickWanderTile(here, 30, tile => {
            checked++;
            return tile.distanceTo(here) === 30;
        }, () => 0.5);

        expect(checked).toBe(1);
        expect(target?.distanceTo(here)).toBe(30);
    });

    test('falls back to a shorter navigable hop', () => {
        const target = pickWanderTile(here, 30, tile => tile.distanceTo(here) === 15, () => 0.25);
        expect(target?.distanceTo(here)).toBe(15);
    });

    test('never chooses an upper floor from ground level', () => {
        const target = pickWanderTile(here, 30, () => true, () => 0);
        expect(target?.level).toBe(0);
    });

    test('returns null instead of walking to an unnavigable tile', () => {
        expect(pickWanderTile(here, 30, () => false, () => 0.5)).toBeNull();
    });
});
