import { pgTable, text, serial, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// === TABLE DEFINITIONS ===

// Hex tiles for the map
export const tiles = pgTable("tiles", {
  id: serial("id").primaryKey(),
  q: integer("q").notNull(), // Axial coordinate q
  r: integer("r").notNull(), // Axial coordinate r
  type: text("type").notNull(), // Planet type: 'terra', 'oxide', 'volcanic', 'desert', 'swamp', 'titanium', 'ice', 'transdim', 'gaia', 'space', 'deep_space'
  sector: integer("sector"), // Which map sector this tile belongs to (optional, for modular board)
  structure: text("structure"), // 'mine', 'trading_station', 'research_lab', 'academy', 'planetary_institute', 'gaia_former', 'ship'
  ownerId: integer("owner_id"), // Player ID who owns the structure
});

// Player state
export const players = pgTable("players", {
  id: serial("id").primaryKey(),
  faction: text("faction").notNull(), // e.g., 'Terrans', 'Lantids'
  ore: integer("ore").default(0).notNull(),
  knowledge: integer("knowledge").default(0).notNull(),
  credits: integer("credits").default(0).notNull(),
  qic: integer("qic").default(0).notNull(),
  power1: integer("power1").default(0).notNull(), // Power Bowl 1
  power2: integer("power2").default(0).notNull(), // Power Bowl 2
  power3: integer("power3").default(0).notNull(), // Power Bowl 3
  score: integer("score").default(10).notNull(),
  ships: integer("ships").default(0).notNull(), // Forgotten Fleet expansion
  startingMinesPlaced: integer("starting_mines_placed").default(0).notNull(), // Track starting phase mines (max 2)
  // Research tracks (levels 0-5)
  researchTerraforming: integer("research_terraforming").default(0).notNull(),
  researchNavigation: integer("research_navigation").default(0).notNull(),
  researchAI: integer("research_ai").default(0).notNull(),
  researchGaia: integer("research_gaia").default(0).notNull(),
  researchEconomy: integer("research_economy").default(0).notNull(),
  researchScience: integer("research_science").default(0).notNull(),
});

// === SCHEMAS ===

export const insertTileSchema = createInsertSchema(tiles).omit({ id: true });
export const insertPlayerSchema = createInsertSchema(players).omit({ id: true });

// === TYPES ===

export type Tile = typeof tiles.$inferSelect;
export type InsertTile = z.infer<typeof insertTileSchema>;

export type Player = typeof players.$inferSelect;
export type InsertPlayer = z.infer<typeof insertPlayerSchema>;

export type TileResponse = Tile;
export type PlayerResponse = Player;
