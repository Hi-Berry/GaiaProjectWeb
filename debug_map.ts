
import { generateMap, SECTOR_LAYOUTS, SECTOR_OFFSETS } from './shared/gameConfig';

console.log("--- Debugging Map Generation ---");
console.log(`Offsets count: ${SECTOR_OFFSETS.length}`);
console.log(`Layouts keys: ${Object.keys(SECTOR_LAYOUTS).join(', ')}`);

try {
    const tiles = generateMap();
    console.log(`Total Tiles Generated: ${tiles.length}`);

    // Count types
    const counts: Record<string, number> = {};
    tiles.forEach(t => {
        counts[t.type] = (counts[t.type] || 0) + 1;
    });
    console.log("Tile Type Counts:", counts);

    // Check bounds
    let minQ = 0, maxQ = 0, minR = 0, maxR = 0;
    tiles.forEach(t => {
        minQ = Math.min(minQ, t.q);
        maxQ = Math.max(maxQ, t.q);
        minR = Math.min(minR, t.r);
        maxR = Math.max(maxR, t.r);
    });
    console.log(`Map Bounds: Q[${minQ}, ${maxQ}], R[${minR}, ${maxR}]`);

    // Check Sector 10 specifically (Deep Space)
    const deepSpace = tiles.filter(t => t.sector === 11); // Offset index 10 is sector 11
    console.log(`Sector 11 (Deep Space) Tiles: ${deepSpace.length}`);
    if (deepSpace.length > 0) {
        console.log("Sector 11 Sample:", deepSpace[0]);
    }

    // Check Sector 20 (Ship)
    const shipSector = tiles.filter(t => t.sector === 17); // Offset 16 is first interspace? 0-9(10), 10-15(6) -> 16
    // Wait, indices:
    // 0-9: Base (10)
    // 10-15: Deep Space (6)
    // 16-19: Interspace (4)
    // Total 20 sectors.

    const ships = tiles.filter(t => t.type === 'lost_fleet_ship');
    console.log(`Total Ships Found: ${ships.length}`);

} catch (error) {
    console.error("Map Generation Error:", error);
}
