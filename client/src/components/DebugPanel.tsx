import { useState, useEffect } from 'react';
import { GameState, GameClient } from '@/lib/gameClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Wrench, Zap } from 'lucide-react';

interface DebugPanelProps {
    game: GameState;
    playerId: string | null;
}

export function DebugPanel({ game, playerId }: DebugPanelProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [credits, setCredits] = useState('0');
    const [ore, setOre] = useState('0');
    const [knowledge, setKnowledge] = useState('0');
    const [qic, setQic] = useState('0');
    // Power bowls
    const [power1, setPower1] = useState('0');
    const [power2, setPower2] = useState('0');
    const [power3, setPower3] = useState('0');

    const player = playerId ? game.players[playerId] : null;

    // Sync state with current player resources when panel opens
    useEffect(() => {
        if (isOpen && player) {
            setCredits(player.credits.toString());
            setOre(player.ore.toString());
            setKnowledge(player.knowledge.toString());
            setQic(player.qic.toString());
            setPower1(player.power1.toString());
            setPower2(player.power2.toString());
            setPower3(player.power3.toString());
        }
    }, [isOpen, player]);

    if (!playerId) return null;

    const handleSetResources = () => {
        GameClient.debugSetResources(game.id, {
            credits: parseInt(credits) || 0,
            ore: parseInt(ore) || 0,
            knowledge: parseInt(knowledge) || 0,
            qic: parseInt(qic) || 0,
            power1: parseInt(power1) || 0,
            power2: parseInt(power2) || 0,
            power3: parseInt(power3) || 0,
        });
    };

    // Quick power actions
    const handleChargePower = (amount: number) => {
        if (!player) return;
        let b1 = player.power1;
        let b2 = player.power2;
        let b3 = player.power3;
        let remaining = amount;

        // Move from bowl1 to bowl2
        const move1to2 = Math.min(b1, remaining);
        b1 -= move1to2;
        b2 += move1to2;
        remaining -= move1to2;

        // Move from bowl2 to bowl3
        const move2to3 = Math.min(b2, remaining);
        b2 -= move2to3;
        b3 += move2to3;

        GameClient.debugSetResources(game.id, {
            power1: b1, power2: b2, power3: b3,
        });
    };

    const handleBurnPower = () => {
        if (!player || player.power2 < 2) return;
        GameClient.debugSetResources(game.id, {
            power1: player.power1,
            power2: player.power2 - 2,
            power3: player.power3 + 1,
        });
    };

    return (
        <div className="w-full">
            {!isOpen && (
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setIsOpen(true)}
                    className="w-full"
                >
                    <Wrench className="w-4 h-4 mr-2" />
                    Debug Panel
                </Button>
            )}

            {isOpen && (
                <div className="space-y-3">
                    <div className="flex items-center justify-between">
                        <h4 className="text-sm font-bold flex items-center gap-2">
                            <Wrench className="w-4 h-4" />
                            Debug Mode
                        </h4>
                        <Button variant="ghost" size="sm" onClick={() => setIsOpen(false)}>×</Button>
                    </div>

                    <div className="flex items-center justify-between">
                        <Label className="text-xs">Test Mode</Label>
                        <Switch
                            checked={game.isTestMode}
                            onCheckedChange={() => GameClient.toggleTestMode(game.id)}
                        />
                    </div>

                    {game.isTestMode && (
                        <div className="space-y-3 pt-3 border-t">
                            {/* Basic Resources */}
                            <div className="grid grid-cols-2 gap-2">
                                <div className="space-y-1">
                                    <Label className="text-xs">Credits</Label>
                                    <Input
                                        type="number"
                                        value={credits}
                                        onChange={(e) => setCredits(e.target.value)}
                                        className="h-7 text-sm"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <Label className="text-xs">Ore</Label>
                                    <Input
                                        type="number"
                                        value={ore}
                                        onChange={(e) => setOre(e.target.value)}
                                        className="h-7 text-sm"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <Label className="text-xs">Knowledge</Label>
                                    <Input
                                        type="number"
                                        value={knowledge}
                                        onChange={(e) => setKnowledge(e.target.value)}
                                        className="h-7 text-sm"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <Label className="text-xs">QIC</Label>
                                    <Input
                                        type="number"
                                        value={qic}
                                        onChange={(e) => setQic(e.target.value)}
                                        className="h-7 text-sm"
                                    />
                                </div>
                            </div>

                            {/* Power Bowls */}
                            <div className="pt-2 border-t">
                                <Label className="text-xs font-bold flex items-center gap-1 mb-2">
                                    <Zap className="w-3 h-3" /> Power Bowls
                                </Label>
                                <div className="grid grid-cols-3 gap-1">
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-center block">Bowl 1</Label>
                                        <Input
                                            type="number"
                                            value={power1}
                                            onChange={(e) => setPower1(e.target.value)}
                                            className="h-7 text-sm text-center px-1"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-center block">Bowl 2</Label>
                                        <Input
                                            type="number"
                                            value={power2}
                                            onChange={(e) => setPower2(e.target.value)}
                                            className="h-7 text-sm text-center px-1"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-center block">Bowl 3</Label>
                                        <Input
                                            type="number"
                                            value={power3}
                                            onChange={(e) => setPower3(e.target.value)}
                                            className="h-7 text-sm text-center px-1"
                                        />
                                    </div>
                                </div>
                                {/* Quick Power Actions */}
                                <div className="flex gap-1 mt-2">
                                    <Button 
                                        variant="outline" 
                                        size="sm" 
                                        className="flex-1 h-6 text-xs"
                                        onClick={() => handleChargePower(1)}
                                    >
                                        +1 ⚡
                                    </Button>
                                    <Button 
                                        variant="outline" 
                                        size="sm" 
                                        className="flex-1 h-6 text-xs"
                                        onClick={() => handleChargePower(3)}
                                    >
                                        +3 ⚡
                                    </Button>
                                    <Button 
                                        variant="outline" 
                                        size="sm" 
                                        className="flex-1 h-6 text-xs text-orange-500"
                                        onClick={handleBurnPower}
                                        disabled={!player || player.power2 < 2}
                                    >
                                        Burn
                                    </Button>
                                </div>
                            </div>

                            <Button onClick={handleSetResources} size="sm" className="w-full">
                                Set All Resources
                            </Button>
                            <p className="text-xs text-muted-foreground">
                                * Test Mode bypasses rules
                            </p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
