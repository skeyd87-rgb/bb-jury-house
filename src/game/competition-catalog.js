// Shared by browser and room server; no DOM dependencies.
export const COMP_TYPES = ['timing', 'reaction', 'memory', 'order', 'circuit'];
export const COMP_NAMES = { timing: 'Pressure Cooker', reaction: 'Snap Judgment', memory: 'Signal Recall', order: 'Stack Order', circuit: 'Power Grid', count: 'Signal Recall' };
export function randomCompType() { return COMP_TYPES[Math.floor(Math.random() * COMP_TYPES.length)]; }
