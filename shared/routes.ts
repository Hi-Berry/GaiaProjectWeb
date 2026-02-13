import { z } from 'zod';
import { insertTileSchema, insertPlayerSchema, tiles, players } from './schema';

// ============================================
// SHARED ERROR SCHEMAS
// ============================================
export const errorSchemas = {
  notFound: z.object({
    message: z.string(),
  }),
  internal: z.object({
    message: z.string(),
  }),
};

// ============================================
// API CONTRACT
// ============================================
export const api = {
  map: {
    list: {
      method: 'GET' as const,
      path: '/api/map',
      responses: {
        200: z.array(z.custom<typeof tiles.$inferSelect>()),
      },
    },
    reset: {
      method: 'POST' as const,
      path: '/api/map/reset',
      responses: {
        200: z.object({ message: z.string() }),
      },
    }
  },
  players: {
    get: {
      method: 'GET' as const,
      path: '/api/players/:id',
      responses: {
        200: z.custom<typeof players.$inferSelect>(),
        404: errorSchemas.notFound,
      },
    },
    update: {
      method: 'PUT' as const,
      path: '/api/players/:id',
      input: insertPlayerSchema.partial(),
      responses: {
        200: z.custom<typeof players.$inferSelect>(),
        404: errorSchemas.notFound,
      },
    },
    // Power actions and free actions
    action: {
      method: 'POST' as const,
      path: '/api/players/:id/action',
      input: z.object({
        type: z.enum(['convert_power', 'sacrifice_power', 'build_mine', 'move_ship']),
        params: z.any()
      }),
      responses: {
        200: z.object({ player: z.custom<typeof players.$inferSelect>(), tiles: z.array(z.custom<typeof tiles.$inferSelect>()).optional() }),
        400: z.object({ message: z.string() }),
      }
    },
    // For demo purposes, create a default player if none exists
    init: {
      method: 'POST' as const,
      path: '/api/players/init',
      responses: {
        201: z.custom<typeof players.$inferSelect>(),
      },
    }
  },
};

// ============================================
// HELPER FUNCTIONS
// ============================================
export function buildUrl(path: string, params?: Record<string, string | number>): string {
  let url = path;
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (url.includes(`:${key}`)) {
        url = url.replace(`:${key}`, String(value));
      }
    });
  }
  return url;
}
