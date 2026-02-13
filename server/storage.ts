import { db } from "./db";
import {
  tiles, players,
  type Tile, type InsertTile,
  type Player, type InsertPlayer
} from "@shared/schema";
import { eq } from "drizzle-orm";

export interface IStorage {
  // Map
  getTiles(): Promise<Tile[]>;
  createTile(tile: InsertTile): Promise<Tile>;
  resetMap(): Promise<void>;

  // Players
  getPlayer(id: number): Promise<Player | undefined>;
  createPlayer(player: InsertPlayer): Promise<Player>;
  updatePlayer(id: number, updates: Partial<InsertPlayer>): Promise<Player>;
  getAllPlayers(): Promise<Player[]>;
  updateTile(id: number, updates: Partial<InsertTile>): Promise<Tile>;
}

export class DatabaseStorage implements IStorage {
  async getTiles(): Promise<Tile[]> {
    return await db!.select().from(tiles);
  }

  async createTile(tile: InsertTile): Promise<Tile> {
    const [newTile] = await db!.insert(tiles).values(tile).returning();
    return newTile;
  }

  async updateTile(id: number, updates: Partial<InsertTile>): Promise<Tile> {
    const [updated] = await db!.update(tiles)
      .set(updates)
      .where(eq(tiles.id, id))
      .returning();
    return updated;
  }

  async resetMap(): Promise<void> {
    await db!.delete(tiles);
  }

  async getPlayer(id: number): Promise<Player | undefined> {
    const [player] = await db!.select().from(players).where(eq(players.id, id));
    return player;
  }

  async getAllPlayers(): Promise<Player[]> {
    return await db!.select().from(players);
  }

  async createPlayer(player: InsertPlayer): Promise<Player> {
    const [newPlayer] = await db!.insert(players).values(player).returning();
    return newPlayer;
  }

  async updatePlayer(id: number, updates: Partial<InsertPlayer>): Promise<Player> {
    const [updated] = await db!.update(players)
      .set(updates)
      .where(eq(players.id, id))

      .returning();
    return updated;
  }
}

export class MemStorage implements IStorage {
  private tiles: Map<number, Tile>;
  private players: Map<number, Player>;
  private tileIdCounter: number;
  private playerIdCounter: number;

  constructor() {
    this.tiles = new Map();
    this.players = new Map();
    this.tileIdCounter = 1;
    this.playerIdCounter = 1;
  }

  async getTiles(): Promise<Tile[]> {
    return Array.from(this.tiles.values());
  }

  async createTile(tile: InsertTile): Promise<Tile> {
    const id = this.tileIdCounter++;
    const newTile: Tile = { ...tile, id, sector: tile.sector ?? null, structure: tile.structure ?? null, ownerId: tile.ownerId ?? null };
    this.tiles.set(id, newTile);
    return newTile;
  }

  async updateTile(id: number, updates: Partial<InsertTile>): Promise<Tile> {
    const existing = this.tiles.get(id);
    if (!existing) throw new Error(`Tile ${id} not found`);
    const updated = { ...existing, ...updates };
    this.tiles.set(id, updated);
    return updated;
  }

  async resetMap(): Promise<void> {
    this.tiles.clear();
    this.tileIdCounter = 1;
  }

  async getPlayer(id: number): Promise<Player | undefined> {
    return this.players.get(id);
  }

  async getAllPlayers(): Promise<Player[]> {
    return Array.from(this.players.values());
  }

  async createPlayer(player: InsertPlayer): Promise<Player> {
    const id = this.playerIdCounter++;
    const newPlayer: Player = {
      ...player,
      id,
      ore: player.ore ?? 0,
      knowledge: player.knowledge ?? 0,
      credits: player.credits ?? 0,
      qic: player.qic ?? 0,
      power1: player.power1 ?? 0,
      power2: player.power2 ?? 0,
      power3: player.power3 ?? 0,
      score: player.score ?? 10,
      ships: player.ships ?? 0,
      startingMinesPlaced: player.startingMinesPlaced ?? 0,
      researchTerraforming: player.researchTerraforming ?? 0,
      researchNavigation: player.researchNavigation ?? 0,
      researchAI: player.researchAI ?? 0,
      researchGaia: player.researchGaia ?? 0,
      researchEconomy: player.researchEconomy ?? 0,
      researchScience: player.researchScience ?? 0
    };
    this.players.set(id, newPlayer);
    return newPlayer;
  }

  async updatePlayer(id: number, updates: Partial<InsertPlayer>): Promise<Player> {
    const existing = this.players.get(id);
    if (!existing) throw new Error(`Player ${id} not found`);
    const updated = { ...existing, ...updates };
    this.players.set(id, updated);
    return updated;
  }
}

export const storage = process.env.DATABASE_URL ? new DatabaseStorage() : new MemStorage();
