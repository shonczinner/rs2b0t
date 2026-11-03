import { Equipment } from '../../api/equipment/Equipment.js';
import { Inventory } from '../../api/inventory/Inventory.js';
import { AXES, KNIFE } from '../../api/acquisition/Tools.js';
import { findCarrier } from './carrier.js';

export const AXE_NAMES = AXES.map(axe => axe.name);

export function hasAxe(): boolean {
    return AXE_NAMES.some(name => Inventory.count(name) > 0 || Equipment.contains(name));
}

export function hasKnife(): boolean {
    return Inventory.count(KNIFE) > 0;
}

export function kitReady(preferredCarrier?: string): boolean {
    const carrier = preferredCarrier ? Inventory.first(preferredCarrier) : findCarrier();
    return hasAxe() && hasKnife() && carrier !== null;
}
