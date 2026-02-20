# Gaia Project Game Clone

## Overview

This is a digital implementation of a Gaia Project-style board game featuring a hexagonal galaxy map, faction-based gameplay, and resource management. The application provides an interactive game interface where players manage resources, build structures on planets, and compete for galactic dominance.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter (lightweight React router)
- **State Management**: TanStack React Query for server state caching and synchronization
- **Styling**: Tailwind CSS with custom CSS variables for theming
- **UI Components**: Shadcn/ui component library (Radix UI primitives)
- **Animations**: Framer Motion for smooth transitions
- **Hex Grid**: react-hexgrid library for rendering the galaxy map

The frontend uses a single-page application structure with the main game interface at the root route. Custom fonts (Orbitron, Rajdhani, Share Tech Mono) create a sci-fi aesthetic.

### Backend Architecture
- **Runtime**: Node.js with Express
- **Language**: TypeScript compiled with TSX
- **API Design**: RESTful endpoints defined in `shared/routes.ts` with Zod validation
- **Database ORM**: Drizzle ORM with PostgreSQL
- **Multiplayer**: Socket.IO for real-time game synchronization

The backend follows a modular structure:
- `server/routes.ts`: API endpoint registration and request handling
- `server/storage.ts`: Database abstraction layer implementing IStorage interface
- `server/db.ts`: Database connection pool configuration
- `server/gameState.ts`: Multiplayer game state management with Socket.IO

### Multiplayer System
- **Socket.IO Integration**: Runs on same port (5000) as Express server
- **Game State**: In-memory storage for active games (Map-based)
- **Player Identification**: Persistent playerId (stored in localStorage) separate from socket.id
- **Reconnection**: Players can rejoin games after disconnect using stored playerId
- **Host System**: Each game has a hostId - only host can start the game
- **Room Isolation**: Game updates emitted only to players in that game's room

### Game Phases
1. **Lobby**: Players create/join games, wait for 2-4 players
2. **Faction Selection**: Each player chooses a faction (7 available)
3. **Starting Mines**: Players place 2 initial mines on home planet tiles
4. **Main Game**: Turn-based gameplay with building and resource management

### Socket Events
- `create_game`: Create new game lobby
- `join_game`: Join existing game
- `rejoin_game`: Reconnect to game with stored playerId
- `start_game`: Host starts the game (requires 2+ players)
- `select_faction`: Choose faction during selection phase
- `confirm_factions`: Advance to starting mines phase
- `place_starting_mine`: Place initial mine on home planet
- `build_mine`: Build mine during main game
- `end_turn`: End current player's turn
- `game_updated`: Broadcasts game state changes to room

### Data Storage
- **Database**: PostgreSQL via Drizzle ORM
- **Schema Location**: `shared/schema.ts` contains all table definitions
- **Tables**:
  - `tiles`: Hexagonal map tiles with axial coordinates (q, r), planet types (terra, oxide, volcanic, desert, swamp, titanium, ice, transdim, gaia, space, deep_space), structures (mine, trading_station, research_lab, planetary_institute, academy, ship), sector ID, and ownership
  - `players`: Player state including faction, resources (ore, knowledge, credits, QIC), power bowls (1, 2, 3), score, ships count, and research levels (Terraforming, Navigation, AI, Gaia, Economy, Science)

### Map System
- **Sector Layout**: 10 sectors arranged in 3-4-3 pattern (matches actual Gaia Project board)
- **Sector Structure**: Each sector has 19 hexes with specific planet type arrangements
- **Seeding**: Map is seeded on first load with predefined sector layouts using SECTOR_CENTERS for positioning
- **Planet Types**: terra, oxide, volcanic, desert, swamp, titanium, ice, transdim, gaia, space, deep_space

### Player Dashboard
- **Faction Mat Design**: Matches actual Gaia Project player mat aesthetics
- **Structure Slots**: 8 Mines, 4 Trading Stations, 3 Research Labs, 1 Planetary Institute, 2 Academies
- **Resource Bars**: Visual bars for Ore, Knowledge, Credits, Q.I.C
- **Power Cycle**: Triangular arrangement of 3 power bowls with flow arrows

### Game Mechanics
- **Power Cycle**: Three-tier power bowl system (Bowl 1 → Bowl 2 → Bowl 3)
  - Charging power moves tokens: Bowl 1 → Bowl 2 → Bowl 3
  - Spending power moves tokens from Bowl 3 back to Bowl 1
- **Free Actions** (can be performed anytime):
  - Sacrifice Power: Spend 2 from Bowl 2 to gain 1 in Bowl 3
  - Convert to Credits: 1 power from Bowl 3 → Bowl 1 = 1 credit
  - Convert to Ore: 3 power from Bowl 3 → Bowl 1 = 1 ore
  - Convert to Knowledge: 4 power from Bowl 3 → Bowl 1 = 1 knowledge
  - Convert to Q.I.C: 4 power from Bowl 3 → Bowl 1 = 1 Q.I.C
- **Research Tracks** (6 areas, levels 0-5):
  - Terraforming: Reduces ore cost per terraforming step
  - Navigation: Increases building range (base 1 + level)
  - AI, Gaia Project, Economy, Science: Future expansion mechanics
  - Advancement costs 4 knowledge per level
- **Construction**:
  - Mine: Costs 1 ore + 2 credits + terraforming ore (based on planet type distance)
  - Range: Must be within Navigation range of existing structures
- **Structure Upgrades**:
  - Mine → Trading Station (2 ore + 6 credits)
  - Trading Station → Research Lab (3 ore + 5 credits) OR Planetary Institute (4 ore + 6 credits)
  - Research Lab → Academy (6 ore + 6 credits)
- **Terraforming**:
  - Planet color wheel: terra→oxide→volcanic→desert→swamp→titanium→ice→transdim (circular)
  - Cost = 3 ore per step - Terraforming research level (min 1)
  - Gaia planets require 1 Q.I.C instead of terraforming
- **Forgotten Fleet Expansion**:
  - Ships: Deploy ships to space/deep_space tiles, costs 1 Q.I.C
  - Deep Space: Special darker tile type for expansion mechanics

### API Contract
The API uses a typed contract pattern in `shared/routes.ts`:
- All endpoints define method, path, input schemas, and response schemas
- Enables type-safe API calls from the client
- Supports parameterized URLs with a `buildUrl` helper

### Build System
- **Development**: Vite dev server with HMR, proxying API requests to Express
- **Production**: Custom build script using esbuild for server bundling and Vite for client
- **Output**: `dist/` directory with `index.cjs` (server) and `public/` (client assets)

## External Dependencies

### Database
- **PostgreSQL**: Primary data store, connection via `DATABASE_URL` environment variable
- **Drizzle Kit**: Schema migrations via `db:push` command

### Key NPM Packages
- `drizzle-orm` / `drizzle-zod`: Database ORM with Zod schema generation
- `@tanstack/react-query`: Async state management
- `react-hexgrid`: Hexagonal grid rendering
- `framer-motion`: Animation library
- `zod`: Runtime type validation
- `express-session` / `connect-pg-simple`: Session management (available but not currently used)

### Development Tools
- `tsx`: TypeScript execution for development
- `vite`: Frontend build tool and dev server
- Replit-specific plugins for dev banners and error overlays