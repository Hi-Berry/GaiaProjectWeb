import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";

// Actual Gaia Project sector data - hexagonal sector shape
// Each sector has 19 hexes: center (1) + ring1 (6) + ring2 (12) = 19
// Positions are relative to sector center using axial coordinates
const SECTOR_HEX_POSITIONS = [
  // Center (pos 0)
  { q: 0, r: 0 },
  // Ring 1 - 6 hexes adjacent to center (pos 1-6)
  { q: 1, r: -1 },  // top-right
  { q: 1, r: 0 },   // right
  { q: 0, r: 1 },   // bottom-right
  { q: -1, r: 1 },  // bottom-left
  { q: -1, r: 0 },  // left
  { q: 0, r: -1 },  // top-left
  // Ring 2 - 12 hexes outer ring (pos 7-18)
  { q: 2, r: -2 },  // top
  { q: 2, r: -1 },  // top-right-1
  { q: 2, r: 0 },   // right-top
  { q: 1, r: 1 },   // right-bottom
  { q: 0, r: 2 },   // bottom-right
  { q: -1, r: 2 },  // bottom
  { q: -2, r: 2 },  // bottom-left
  { q: -2, r: 1 },  // left-bottom
  { q: -2, r: 0 },  // left-top
  { q: -1, r: -1 }, // top-left-1
  { q: 0, r: -2 },  // top-left-2
  { q: 1, r: -2 },  // top-right-2
];

// Sector definitions with actual planet layouts (inspired by real Gaia Project sectors)
// Each sector has 19 hexes (pos 0-18) matching SECTOR_HEX_POSITIONS
// Based on the image: center + ring1 (6 around) + ring2 (12 outer)
const SECTORS: { id: number; planets: { pos: number; type: string }[] }[] = [
  // Sector 1 (based on provided image pattern)
  { id: 1, planets: [
    { pos: 0, type: 'terra' },     // center - blue planet
    { pos: 1, type: 'transdim' },  // ring1
    { pos: 2, type: 'space' },
    { pos: 3, type: 'volcanic' },
    { pos: 4, type: 'desert' },
    { pos: 5, type: 'gaia' },
    { pos: 6, type: 'ice' },
    { pos: 7, type: 'oxide' },     // ring2 - top
    { pos: 8, type: 'space' },
    { pos: 9, type: 'space' },
    { pos: 10, type: 'space' },
    { pos: 11, type: 'swamp' },
    { pos: 12, type: 'space' },
    { pos: 13, type: 'space' },
    { pos: 14, type: 'titanium' },
    { pos: 15, type: 'space' },
    { pos: 16, type: 'space' },
    { pos: 17, type: 'space' },
    { pos: 18, type: 'space' },
  ]},
  // Sector 2
  { id: 2, planets: [
    { pos: 0, type: 'space' },
    { pos: 1, type: 'swamp' },
    { pos: 2, type: 'titanium' },
    { pos: 3, type: 'space' },
    { pos: 4, type: 'volcanic' },
    { pos: 5, type: 'transdim' },
    { pos: 6, type: 'space' },
    { pos: 7, type: 'oxide' },
    { pos: 8, type: 'space' },
    { pos: 9, type: 'ice' },
    { pos: 10, type: 'space' },
    { pos: 11, type: 'desert' },
    { pos: 12, type: 'gaia' },
    { pos: 13, type: 'space' },
    { pos: 14, type: 'space' },
    { pos: 15, type: 'terra' },
    { pos: 16, type: 'space' },
    { pos: 17, type: 'space' },
    { pos: 18, type: 'space' },
  ]},
  // Sector 3
  { id: 3, planets: [
    { pos: 0, type: 'gaia' },
    { pos: 1, type: 'terra' },
    { pos: 2, type: 'space' },
    { pos: 3, type: 'titanium' },
    { pos: 4, type: 'space' },
    { pos: 5, type: 'transdim' },
    { pos: 6, type: 'ice' },
    { pos: 7, type: 'space' },
    { pos: 8, type: 'desert' },
    { pos: 9, type: 'space' },
    { pos: 10, type: 'volcanic' },
    { pos: 11, type: 'space' },
    { pos: 12, type: 'space' },
    { pos: 13, type: 'oxide' },
    { pos: 14, type: 'space' },
    { pos: 15, type: 'swamp' },
    { pos: 16, type: 'space' },
    { pos: 17, type: 'space' },
    { pos: 18, type: 'space' },
  ]},
  // Sector 4
  { id: 4, planets: [
    { pos: 0, type: 'terra' },
    { pos: 1, type: 'space' },
    { pos: 2, type: 'swamp' },
    { pos: 3, type: 'titanium' },
    { pos: 4, type: 'space' },
    { pos: 5, type: 'volcanic' },
    { pos: 6, type: 'space' },
    { pos: 7, type: 'oxide' },
    { pos: 8, type: 'gaia' },
    { pos: 9, type: 'space' },
    { pos: 10, type: 'ice' },
    { pos: 11, type: 'transdim' },
    { pos: 12, type: 'space' },
    { pos: 13, type: 'desert' },
    { pos: 14, type: 'space' },
    { pos: 15, type: 'space' },
    { pos: 16, type: 'space' },
    { pos: 17, type: 'space' },
    { pos: 18, type: 'space' },
  ]},
  // Sector 5
  { id: 5, planets: [
    { pos: 0, type: 'space' },
    { pos: 1, type: 'gaia' },
    { pos: 2, type: 'space' },
    { pos: 3, type: 'volcanic' },
    { pos: 4, type: 'transdim' },
    { pos: 5, type: 'space' },
    { pos: 6, type: 'oxide' },
    { pos: 7, type: 'ice' },
    { pos: 8, type: 'space' },
    { pos: 9, type: 'desert' },
    { pos: 10, type: 'terra' },
    { pos: 11, type: 'space' },
    { pos: 12, type: 'titanium' },
    { pos: 13, type: 'swamp' },
    { pos: 14, type: 'space' },
    { pos: 15, type: 'space' },
    { pos: 16, type: 'space' },
    { pos: 17, type: 'space' },
    { pos: 18, type: 'space' },
  ]},
  // Sector 6
  { id: 6, planets: [
    { pos: 0, type: 'transdim' },
    { pos: 1, type: 'terra' },
    { pos: 2, type: 'swamp' },
    { pos: 3, type: 'space' },
    { pos: 4, type: 'gaia' },
    { pos: 5, type: 'space' },
    { pos: 6, type: 'volcanic' },
    { pos: 7, type: 'transdim' },
    { pos: 8, type: 'space' },
    { pos: 9, type: 'desert' },
    { pos: 10, type: 'ice' },
    { pos: 11, type: 'space' },
    { pos: 12, type: 'oxide' },
    { pos: 13, type: 'space' },
    { pos: 14, type: 'titanium' },
    { pos: 15, type: 'space' },
    { pos: 16, type: 'space' },
    { pos: 17, type: 'space' },
    { pos: 18, type: 'space' },
  ]},
  // Sector 7
  { id: 7, planets: [
    { pos: 0, type: 'swamp' },
    { pos: 1, type: 'space' },
    { pos: 2, type: 'gaia' },
    { pos: 3, type: 'titanium' },
    { pos: 4, type: 'space' },
    { pos: 5, type: 'transdim' },
    { pos: 6, type: 'gaia' },
    { pos: 7, type: 'oxide' },
    { pos: 8, type: 'space' },
    { pos: 9, type: 'terra' },
    { pos: 10, type: 'volcanic' },
    { pos: 11, type: 'space' },
    { pos: 12, type: 'ice' },
    { pos: 13, type: 'desert' },
    { pos: 14, type: 'space' },
    { pos: 15, type: 'space' },
    { pos: 16, type: 'space' },
    { pos: 17, type: 'space' },
    { pos: 18, type: 'space' },
  ]},
  // Sector 8
  { id: 8, planets: [
    { pos: 0, type: 'space' },
    { pos: 1, type: 'terra' },
    { pos: 2, type: 'space' },
    { pos: 3, type: 'titanium' },
    { pos: 4, type: 'volcanic' },
    { pos: 5, type: 'space' },
    { pos: 6, type: 'transdim' },
    { pos: 7, type: 'transdim' },
    { pos: 8, type: 'gaia' },
    { pos: 9, type: 'ice' },
    { pos: 10, type: 'oxide' },
    { pos: 11, type: 'swamp' },
    { pos: 12, type: 'space' },
    { pos: 13, type: 'desert' },
    { pos: 14, type: 'space' },
    { pos: 15, type: 'space' },
    { pos: 16, type: 'space' },
    { pos: 17, type: 'space' },
    { pos: 18, type: 'space' },
  ]},
  // Sector 9
  { id: 9, planets: [
    { pos: 0, type: 'gaia' },
    { pos: 1, type: 'space' },
    { pos: 2, type: 'volcanic' },
    { pos: 3, type: 'space' },
    { pos: 4, type: 'transdim' },
    { pos: 5, type: 'oxide' },
    { pos: 6, type: 'space' },
    { pos: 7, type: 'ice' },
    { pos: 8, type: 'space' },
    { pos: 9, type: 'desert' },
    { pos: 10, type: 'terra' },
    { pos: 11, type: 'swamp' },
    { pos: 12, type: 'titanium' },
    { pos: 13, type: 'space' },
    { pos: 14, type: 'space' },
    { pos: 15, type: 'space' },
    { pos: 16, type: 'space' },
    { pos: 17, type: 'space' },
    { pos: 18, type: 'space' },
  ]},
  // Sector 10
  { id: 10, planets: [
    { pos: 0, type: 'space' },
    { pos: 1, type: 'swamp' },
    { pos: 2, type: 'titanium' },
    { pos: 3, type: 'space' },
    { pos: 4, type: 'gaia' },
    { pos: 5, type: 'volcanic' },
    { pos: 6, type: 'transdim' },
    { pos: 7, type: 'terra' },
    { pos: 8, type: 'space' },
    { pos: 9, type: 'ice' },
    { pos: 10, type: 'oxide' },
    { pos: 11, type: 'desert' },
    { pos: 12, type: 'space' },
    { pos: 13, type: 'space' },
    { pos: 14, type: 'space' },
    { pos: 15, type: 'space' },
    { pos: 16, type: 'space' },
    { pos: 17, type: 'space' },
    { pos: 18, type: 'space' },
  ]},
];

// Sector center positions for 10-sector layout (3-4-3 pattern)
// 19-hex hexagonal sectors need spacing of 5 hexes between centers
// Arranged in a compact 3-4-3 pattern matching the actual Gaia Project board
const SECTOR_CENTERS = [
  // Top row (3 sectors)
  { q: -5, r: -5, sector: 0 },
  { q: 0, r: -8, sector: 1 },
  { q: 5, r: -11, sector: 2 },
  // Middle row (4 sectors) - offset to interlock with top row
  { q: -8, r: 0, sector: 3 },
  { q: -3, r: -3, sector: 4 },
  { q: 2, r: -6, sector: 5 },
  { q: 7, r: -9, sector: 6 },
  // Bottom row (3 sectors) - offset to interlock with middle row
  { q: -5, r: 2, sector: 7 },
  { q: 0, r: -1, sector: 8 },
  { q: 5, r: -4, sector: 9 },
];

async function seedData() {
  const existingTiles = await storage.getTiles();
  if (existingTiles.length === 0) {
    console.log("Seeding Gaia Project map with 10 sectors...");
    
    // Generate tiles for each sector
    for (const sectorCenter of SECTOR_CENTERS) {
      const sector = SECTORS[sectorCenter.sector];
      
      for (let i = 0; i < SECTOR_HEX_POSITIONS.length && i < sector.planets.length; i++) {
        const hexPos = SECTOR_HEX_POSITIONS[i];
        const planetData = sector.planets.find(p => p.pos === i);
        const type = planetData?.type || 'space';
        
        const q = sectorCenter.q + hexPos.q;
        const r = sectorCenter.r + hexPos.r;
        
        await storage.createTile({ 
          q, 
          r, 
          type,
          sector: sectorCenter.sector,
        });
      }
    }
  }

  const existingPlayers = await storage.getAllPlayers();
  if (existingPlayers.length === 0) {
    console.log("Seeding player...");
    await storage.createPlayer({
      faction: "Terrans",
      ore: 4,
      knowledge: 3,
      credits: 15,
      qic: 1,
      power1: 4,
      power2: 4,
      power3: 2,
      score: 10,
      ships: 0,
      researchTerraforming: 0,
      researchNavigation: 0,
      researchAI: 0,
      researchGaia: 1, // Terrans start at level 1 in Gaia Project
      researchEconomy: 0,
      researchScience: 0
    });
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Initialize data
  await seedData();

  // Map Routes
  app.get(api.map.list.path, async (req, res) => {
    const tiles = await storage.getTiles();
    res.json(tiles);
  });

  app.post(api.map.reset.path, async (req, res) => {
    await storage.resetMap();
    await seedData(); // re-seed
    res.json({ message: "Map reset" });
  });

  // Player Routes
  app.get(api.players.get.path, async (req, res) => {
    const player = await storage.getPlayer(Number(req.params.id));
    if (!player) {
      return res.status(404).json({ message: "Player not found" });
    }
    res.json(player);
  });

  app.put(api.players.update.path, async (req, res) => {
    try {
      const input = api.players.update.input.parse(req.body);
      const updated = await storage.updatePlayer(Number(req.params.id), input);
      res.json(updated);
    } catch (err) {
       if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join('.'),
        });
      }
      res.status(404).json({ message: "Player not found or invalid input" });
    }
  });

  app.post(api.players.init.path, async (req, res) => {
    const allPlayers = await storage.getAllPlayers();
    if (allPlayers.length > 0) {
      return res.status(201).json(allPlayers[0]);
    }
    const newPlayer = await storage.createPlayer({
      faction: "Terrans",
      ore: 4,
      knowledge: 3,
      credits: 15,
      qic: 1,
      power1: 4,
      power2: 4,
      power3: 2,
      score: 10,
      ships: 0,
      researchTerraforming: 0,
      researchNavigation: 0,
      researchAI: 0,
      researchGaia: 1,
      researchEconomy: 0,
      researchScience: 0
    });
    res.status(201).json(newPlayer);
  });

  app.post(api.players.action.path, async (req, res) => {
    const playerId = Number(req.params.id);
    const { type, params } = req.body;
    const player = await storage.getPlayer(playerId);
    if (!player) return res.status(404).json({ message: "Player not found" });

    let updatedPlayer = { ...player };
    let updatedTiles: any[] = [];

    try {
      if (type === 'convert_power') {
        const { resource, amount } = params; // amount in resource units
        if (resource === 'credits') {
          if (player.power3 < amount) throw new Error("Not enough power in Bowl 3");
          updatedPlayer.power3 -= amount;
          updatedPlayer.power1 += amount; // Power moves from Bowl 3 to Bowl 1
          updatedPlayer.credits += amount;
        } else if (resource === 'ore') {
          const powerCost = amount * 3;
          if (player.power3 < powerCost) throw new Error("Not enough power in Bowl 3");
          updatedPlayer.power3 -= powerCost;
          updatedPlayer.power1 += powerCost; // Power moves from Bowl 3 to Bowl 1
          updatedPlayer.ore += amount;
        } else if (resource === 'knowledge') {
          const powerCost = amount * 4;
          if (player.power3 < powerCost) throw new Error("Not enough power in Bowl 3");
          updatedPlayer.power3 -= powerCost;
          updatedPlayer.power1 += powerCost; // Power moves from Bowl 3 to Bowl 1
          updatedPlayer.knowledge += amount;
        } else if (resource === 'qic') {
          const powerCost = amount * 4;
          if (player.power3 < powerCost) throw new Error("Not enough power in Bowl 3");
          updatedPlayer.power3 -= powerCost;
          updatedPlayer.power1 += powerCost; // Power moves from Bowl 3 to Bowl 1
          updatedPlayer.qic += amount;
        }
      } else if (type === 'sacrifice_power') {
        const { amount } = params;
        if (player.power2 < amount * 2) throw new Error("Not enough power in Bowl 2 to sacrifice");
        updatedPlayer.power2 -= amount * 2;
        updatedPlayer.power3 += amount;
      } else if (type === 'build_mine') {
        const { tileId } = params;
        const allTiles = await storage.getTiles();
        const tile = allTiles.find(t => t.id === tileId);
        if (!tile || tile.structure) throw new Error("Invalid tile or already built");
        if (tile.type === 'space' || tile.type === 'deep_space') throw new Error("Cannot build on empty space");
        
        // Check range based on Navigation research level
        // Base range is 1, each Navigation level adds 1 (up to level 5 = range 6)
        const ownedTiles = allTiles.filter(t => t.ownerId === playerId && t.structure);
        const navigationLevel = player.researchNavigation || 0;
        const maxRange = 1 + navigationLevel;
        
        // If player has no structures yet, they can build anywhere (starting placement)
        if (ownedTiles.length > 0) {
          // Calculate hex distance from any owned tile
          const hexDistance = (t1: { q: number, r: number }, t2: { q: number, r: number }) => {
            const dx = t1.q - t2.q;
            const dy = t1.r - t2.r;
            return Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dx + dy));
          };
          
          const inRange = ownedTiles.some(owned => hexDistance(owned, tile) <= maxRange);
          if (!inRange) {
            throw new Error(`Planet is out of range (max range: ${maxRange} with Navigation level ${navigationLevel})`);
          }
        }
        
        // Calculate terraforming cost based on planet type distance
        // Planet type color wheel: terra->oxide->volcanic->desert->swamp->titanium->ice->transdim (circular)
        const planetWheel = ['terra', 'oxide', 'volcanic', 'desert', 'swamp', 'titanium', 'ice', 'transdim'];
        const homePlanet = 'terra'; // Terrans home planet
        
        let terraformSteps = 0;
        if (tile.type !== 'gaia' && tile.type !== homePlanet) {
          const homeIndex = planetWheel.indexOf(homePlanet);
          const targetIndex = planetWheel.indexOf(tile.type);
          if (targetIndex >= 0) {
            const clockwise = (targetIndex - homeIndex + 8) % 8;
            const counterClockwise = (homeIndex - targetIndex + 8) % 8;
            terraformSteps = Math.min(clockwise, counterClockwise);
          }
        }
        // Gaia planets cost 1 Q.I.C to build on (no terraforming needed)
        
        // Base cost: 3 ore per terraforming step, reduced by research level
        const baseCostPerStep = 3;
        const terraformReduction = player.researchTerraforming || 0; // Each level reduces cost by 1
        const costPerStep = Math.max(1, baseCostPerStep - terraformReduction);
        const terraformOreCost = terraformSteps * costPerStep;
        
        // Base mine cost: 1 ore + 2 credits
        const totalOreCost = 1 + terraformOreCost;
        const creditsCost = 2;
        
        // Gaia planets require Q.I.C
        if (tile.type === 'gaia') {
          if (player.qic < 1) throw new Error("Building on Gaia planets requires 1 Q.I.C");
          updatedPlayer.qic -= 1;
        }
        
        if (player.ore < totalOreCost || player.credits < creditsCost) {
          throw new Error(`Not enough resources (need ${totalOreCost} ore + ${creditsCost} credits)`);
        }
        
        updatedPlayer.ore -= totalOreCost;
        updatedPlayer.credits -= creditsCost;
        const newTile = await storage.updateTile(tileId, { structure: 'mine', ownerId: playerId });
        updatedTiles.push(newTile);
      } else if (type === 'place_starting_mine') {
        // Starting phase: place 2 mines on Terra planets for free
        const { tileId } = params;
        const allTiles = await storage.getTiles();
        const tile = allTiles.find(t => t.id === tileId);
        
        if (!tile) throw new Error("Invalid tile");
        if (tile.structure) throw new Error("Tile already has a structure");
        if (tile.type !== 'terra') throw new Error("Starting mines can only be placed on Terra (blue) planets");
        if ((player.startingMinesPlaced || 0) >= 2) throw new Error("You have already placed both starting mines");
        
        updatedPlayer.startingMinesPlaced = (player.startingMinesPlaced || 0) + 1;
        const newTile = await storage.updateTile(tileId, { structure: 'mine', ownerId: playerId });
        updatedTiles.push(newTile);
      } else if (type === 'deploy_ship') {
        const { tileId } = params;
        if (player.qic < 1) throw new Error("Not enough Q.I.C to deploy ship");
        const tile = (await storage.getTiles()).find(t => t.id === tileId);
        if (!tile) throw new Error("Invalid tile");
        if (tile.type !== 'deep_space' && tile.type !== 'space') throw new Error("Ships can only be deployed in space or deep space");
        if (tile.structure) throw new Error("Tile already occupied");
        
        updatedPlayer.qic -= 1;
        updatedPlayer.ships += 1;
        const newTile = await storage.updateTile(tileId, { structure: 'ship', ownerId: playerId });
        updatedTiles.push(newTile);
      } else if (type === 'charge_power') {
        const { amount } = params;
        if (player.power1 >= amount) {
          updatedPlayer.power1 -= amount;
          updatedPlayer.power2 += amount;
        } else {
          const fromBowl1 = player.power1;
          const fromBowl2 = amount - fromBowl1;
          if (player.power2 < fromBowl2) throw new Error("Not enough power to charge");
          updatedPlayer.power1 = 0;
          updatedPlayer.power2 -= fromBowl2;
          updatedPlayer.power2 += fromBowl1;
          updatedPlayer.power3 += fromBowl2;
        }
      } else if (type === 'advance_research') {
        const { area } = params;
        const validAreas = ['terraforming', 'navigation', 'ai', 'gaia', 'economy', 'science'];
        if (!validAreas.includes(area)) throw new Error("Invalid research area");
        const researchKey = `research${area.charAt(0).toUpperCase() + area.slice(1)}` as keyof typeof player;
        const currentLevel = player[researchKey] as number;
        if (currentLevel >= 5) throw new Error("Already at maximum research level");
        if (player.knowledge < 4) throw new Error("Not enough knowledge (need 4)");
        updatedPlayer.knowledge -= 4;
        (updatedPlayer as any)[researchKey] = currentLevel + 1;
      } else if (type === 'upgrade_structure') {
        const { tileId, targetStructure } = params;
        const tile = (await storage.getTiles()).find(t => t.id === tileId);
        if (!tile) throw new Error("Invalid tile");
        if (tile.ownerId !== playerId) throw new Error("You don't own this structure");
        
        const upgradePaths: Record<string, { targets: string[], costs: Record<string, { ore: number, credits: number }> }> = {
          'mine': { 
            targets: ['trading_station'], 
            costs: { 'trading_station': { ore: 2, credits: 6 } } 
          },
          'trading_station': { 
            targets: ['planetary_institute', 'research_lab'], 
            costs: { 
              'planetary_institute': { ore: 4, credits: 6 },
              'research_lab': { ore: 3, credits: 5 }
            } 
          },
          'research_lab': { 
            targets: ['academy'], 
            costs: { 'academy': { ore: 6, credits: 6 } } 
          }
        };
        
        const currentStructure = tile.structure;
        if (!currentStructure || !upgradePaths[currentStructure]) {
          throw new Error("This structure cannot be upgraded");
        }
        
        const path = upgradePaths[currentStructure];
        if (!path.targets.includes(targetStructure)) {
          throw new Error(`Cannot upgrade ${currentStructure} to ${targetStructure}`);
        }
        
        const cost = path.costs[targetStructure];
        if (player.ore < cost.ore || player.credits < cost.credits) {
          throw new Error(`Not enough resources (need ${cost.ore} ore + ${cost.credits} credits)`);
        }
        
        updatedPlayer.ore -= cost.ore;
        updatedPlayer.credits -= cost.credits;
        const newTile = await storage.updateTile(tileId, { structure: targetStructure });
        updatedTiles.push(newTile);
      }

      const finalPlayer = await storage.updatePlayer(playerId, updatedPlayer);
      res.json({ player: finalPlayer, tiles: updatedTiles });
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  return httpServer;
}
