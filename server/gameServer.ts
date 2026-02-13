import { Server, Origins } from 'boardgame.io/server';
import { GaiaProjectGame } from '../shared/gameConfig';

const server = Server({
  games: [GaiaProjectGame],
  origins: [Origins.LOCALHOST_IN_DEVELOPMENT],
});

const PORT = Number(process.env.GAME_SERVER_PORT) || 8000;

server.run(PORT, () => {
  console.log(`[boardgame.io] Game server running on port ${PORT}`);
});

export { server };
