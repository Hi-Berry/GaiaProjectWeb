import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl } from "@shared/routes";

// ============================================
// MAP HOOKS
// ============================================

export function useMap() {
  return useQuery({
    queryKey: [api.map.list.path],
    queryFn: async () => {
      const res = await fetch(api.map.list.path);
      if (!res.ok) throw new Error("Failed to fetch map data");
      return api.map.list.responses[200].parse(await res.json());
    },
  });
}

export function useResetMap() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(api.map.reset.path, {
        method: api.map.reset.method,
      });
      if (!res.ok) throw new Error("Failed to reset map");
      return api.map.reset.responses[200].parse(await res.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.map.list.path] });
    },
  });
}

// ============================================
// PLAYER HOOKS
// ============================================

export function usePlayer(id: number) {
  return useQuery({
    queryKey: [api.players.get.path, id],
    queryFn: async () => {
      const url = buildUrl(api.players.get.path, { id });
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to fetch player");
      return api.players.get.responses[200].parse(await res.json());
    },
  });
}

export function useInitPlayer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(api.players.init.path, {
        method: api.players.init.method,
      });
      if (!res.ok) throw new Error("Failed to initialize player");
      return api.players.init.responses[201].parse(await res.json());
    },
    onSuccess: (data) => {
      queryClient.setQueryData([api.players.get.path, data.id], data);
    },
  });
}

export function useUpdatePlayer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...updates }: { id: number } & Record<string, any>) => {
      const url = buildUrl(api.players.update.path, { id });
      const res = await fetch(url, {
        method: api.players.update.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error("Failed to update player");
      return api.players.update.responses[200].parse(await res.json());
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [api.players.get.path, data.id] });
    },
  });
}

export function usePlayerAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, type, params }: { id: number; type: string; params: any }) => {
      const url = buildUrl(api.players.action.path, { id });
      const res = await fetch(url, {
        method: api.players.action.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, params }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Action failed");
      return data;
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: [api.players.get.path, variables.id] });
      queryClient.invalidateQueries({ queryKey: [api.map.list.path] });
    },
  });
}
