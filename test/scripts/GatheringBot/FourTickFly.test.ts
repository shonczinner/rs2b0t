import { expect, test } from 'bun:test';
import { fourTickFlyProfile } from '#/bot/scripts/GatheringBot/TickManipLogic.js';

test('4-tick fly profile uses the knife cycle and a 3-tick roll cadence', () => {
    const profile = fourTickFlyProfile();
    expect(profile.method).toBe('four-tick-fly');
    expect(profile.fourTickFlyCycle).toBe(true);
    expect(profile.useKnifeDelay).toBe(true);
    expect(profile.timedReclick).toBe(true);
    expect(profile.nativeCycleTicks).toBe(3);
});
