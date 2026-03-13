const fs = require('fs');

const path = './client/src/pages/Game.tsx';
let content = fs.readFileSync(path, 'utf8');

const oldStr = `{/* 방장 전용: 한 컴퓨터 4인플 시 조작 플레이어 전환 */}
        {!isSpectator && isHost && game && game.turnOrder.length > 1 && (
          <div className="p-2 border-b border-border space-y-2 bg-black/80 md:bg-transparent backdrop-blur-sm md:backdrop-blur-none block">
            <label className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
              <Gamepad2 className="w-3.5 h-3.5" />
              <span className="hidden md:inline">조작할 플레이어 & 보드 고정</span>
            </label>
            <div className="flex gap-1">
              <Select
                value={playerId ?? ''}
                onValueChange={async (id) => {
                  if (!gameId || id === playerId) return;
                  try {
                    const { game: updated } = await GameClient.switchPlayer(gameId, id);
                    setGame(updated);
                    setPlayerId(id);
                    storePlayerId(gameId, id);
                  } catch (e: any) {
                    toast({ title: '전환 실패', description: e?.message, variant: 'destructive' });
                  }
                }}
              >
                <SelectTrigger className="h-9 text-xs flex-1">
                  <SelectValue placeholder="플레이어 선택" />
                </SelectTrigger>
                <SelectContent>
                  {game.turnOrder.filter(id => id === game.hostId || game.hostAddedPlayerIds?.includes(id)).map((id) => {
                    const p = game.players[id];
                    return (
                      <SelectItem key={id} value={id} className="text-xs">
                        {p?.name ?? id} {id === game.hostId ? '(Host)' : ''}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9 shrink-0 text-purple-600 hover:text-purple-700 hover:bg-purple-100 dark:text-purple-400 dark:hover:bg-purple-900/50"
                onClick={() => {
                  const newVal = !(isResearchPinned && isBonusPinned);
                  setIsResearchPinned(newVal);
                  setIsBonusPinned(newVal);
                  if (gameId) {
                    localStorage.setItem(\`is-research-pinned-\${gameId}\`, String(newVal));
                    localStorage.setItem(\`is-bonus-pinned-\${gameId}\`, String(newVal));
                  }
                }}
                title="모든 미니보드 켜기/끄기 (Toggle All Mini Boards)"
              >
                <Layers className="w-4 h-4" />
              </Button>
              <Button
                variant={isResearchPinned ? 'default' : 'outline'}
                size="icon"
                className={\`h-9 w-9 shrink-0 \${isResearchPinned ? 'bg-blue-600 hover:bg-blue-500' : ''}\`}
                onClick={() => {
                  const newVal = !isResearchPinned;
                  setIsResearchPinned(newVal);
                  if (gameId) localStorage.setItem(\`is-research-pinned-\${gameId}\`, String(newVal));
                }}
                title="연구 보드 고정 (Research Board Pin)"
              >
                <FlaskConical className="w-4 h-4" />
              </Button>
              <Button
                variant={isBonusPinned ? 'default' : 'outline'}
                size="icon"
                className={\`h-9 w-9 shrink-0 \${isBonusPinned ? 'bg-amber-600 hover:bg-amber-500' : ''}\`}
                onClick={() => {
                  const newVal = !isBonusPinned;
                  setIsBonusPinned(newVal);
                  if (gameId) localStorage.setItem(\`is-bonus-pinned-\${gameId}\`, String(newVal));
                }}
                title="보너스 타일 고정 (Bonus Tiles Pin)"
              >
                <Gift className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}`;

const newStr = `{/* 상단 툴바: 미니뷰 토글 및 (방장 전용) 플레이어 전환 */}
        <div className="p-2 border-b border-border space-y-2 bg-black/80 md:bg-transparent backdrop-blur-sm md:backdrop-blur-none block">
          <div className="flex gap-1 items-end">
            {/* 방장 전용: 한 컴퓨터 4인플 시 조작 플레이어 전환 */}
            {!isSpectator && isHost && game && game.turnOrder.length > 1 && (
              <div className="flex-1 space-y-1">
                <label className="text-xs text-muted-foreground flex items-center gap-1">
                  <Gamepad2 className="w-3.5 h-3.5" />
                  <span className="hidden md:inline">조작할 플레이어 & 보드 고정</span>
                </label>
                <Select
                  value={playerId ?? ''}
                  onValueChange={async (id) => {
                    if (!gameId || id === playerId) return;
                    try {
                      const { game: updated } = await GameClient.switchPlayer(gameId, id);
                      setGame(updated);
                      setPlayerId(id);
                      storePlayerId(gameId, id);
                    } catch (e: any) {
                      toast({ title: '전환 실패', description: e?.message, variant: 'destructive' });
                    }
                  }}
                >
                  <SelectTrigger className="h-9 text-xs w-full">
                    <SelectValue placeholder="플레이어 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {game.turnOrder.filter(id => id === game.hostId || game.hostAddedPlayerIds?.includes(id)).map((id) => {
                      const p = game.players[id];
                      return (
                        <SelectItem key={id} value={id} className="text-xs">
                          {p?.name ?? id} {id === game.hostId ? '(Host)' : ''}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex gap-1 ml-auto">
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9 shrink-0 text-purple-600 hover:text-purple-700 hover:bg-purple-100 dark:text-purple-400 dark:hover:bg-purple-900/50"
                onClick={() => {
                  const newVal = !(isResearchPinned && isBonusPinned);
                  setIsResearchPinned(newVal);
                  setIsBonusPinned(newVal);
                  if (gameId) {
                    localStorage.setItem(\`is-research-pinned-\${gameId}\`, String(newVal));
                    localStorage.setItem(\`is-bonus-pinned-\${gameId}\`, String(newVal));
                  }
                }}
                title="모든 미니보드 켜기/끄기 (Toggle All Mini Boards)"
              >
                <Layers className="w-4 h-4" />
              </Button>
              <Button
                variant={isResearchPinned ? 'default' : 'outline'}
                size="icon"
                className={\`h-9 w-9 shrink-0 \${isResearchPinned ? 'bg-blue-600 hover:bg-blue-500' : ''}\`}
                onClick={() => {
                  const newVal = !isResearchPinned;
                  setIsResearchPinned(newVal);
                  if (gameId) localStorage.setItem(\`is-research-pinned-\${gameId}\`, String(newVal));
                }}
                title="연구 보드 고정 (Research Board Pin)"
              >
                <FlaskConical className="w-4 h-4" />
              </Button>
              <Button
                variant={isBonusPinned ? 'default' : 'outline'}
                size="icon"
                className={\`h-9 w-9 shrink-0 \${isBonusPinned ? 'bg-amber-600 hover:bg-amber-500' : ''}\`}
                onClick={() => {
                  const newVal = !isBonusPinned;
                  setIsBonusPinned(newVal);
                  if (gameId) localStorage.setItem(\`is-bonus-pinned-\${gameId}\`, String(newVal));
                }}
                title="보너스 타일 고정 (Bonus Tiles Pin)"
              >
                <Gift className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>`;

if(content.includes(oldStr)) {
    content = content.replace(oldStr, newStr);
    fs.writeFileSync(path, content, 'utf8');
    console.log("Replaced successfully.");
} else {
    console.log("Could not find string to replace.");
}
