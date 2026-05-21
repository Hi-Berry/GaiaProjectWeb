$path = Join-Path $PSScriptRoot '..\server\ai\aiWeights.json'
$json = Get-Content $path -Raw | ConvertFrom-Json

# 구조물 가중치 표준화 — 광산 < 교역소 < 연구소 < 의회 < 아카데미
# 코드의 DEFAULT_EVALUATOR_WEIGHTS 기반에서 상향
function Set-StructureWeights {
    param($block, [double]$mineBase, [double]$tsBase, [double]$labBase, [double]$piBase, [double]$acaBase)
    $block.structureMine = $mineBase
    $block.structureTradingStation = $tsBase
    $block.structureResearchLab = $labBase
    $block.structurePlanetaryInstitute = $piBase
    $block.structureAcademy = $acaBase
}

# Global: 표준 강한 엔진 빌딩 신호
Set-StructureWeights -block $json.global -mineBase 70 -tsBase 160 -labBase 200 -piBase 280 -acaBase 340

# 사용자 요청: 후반 VP/연방/연구5 강화
$json.global.vpWeightLate = 26
$json.global.federationValueEach = 200
$json.global.researchLevel5Bonus = 420
$json.global.researchLevel4Bonus = 130

# 팩션별 조정: 광산/TS/Lab/PI/Academy를 글로벌 기반으로 살짝씩만 차등화
$factionTweaks = @{
    'terran'        = @{ mine = 75; ts = 160; lab = 200; pi = 290; aca = 340 }    # 평범
    'lantids'       = @{ mine = 90; ts = 150; lab = 200; pi = 320; aca = 320 }    # 광산 다수 전략
    'hadsch_hallas' = @{ mine = 70; ts = 200; lab = 200; pi = 320; aca = 340 }    # TS 강화 (TS당 4크레딧 PI)
    'ivits'         = @{ mine = 75; ts = 160; lab = 210; pi = 320; aca = 340 }    # PI 강력
    'geodens'       = @{ mine = 75; ts = 170; lab = 210; pi = 340; aca = 340 }    # PI 첫 행성타입 보너스
    'bal_tak'       = @{ mine = 70; ts = 160; lab = 200; pi = 280; aca = 360 }    # 아카데미 가이아포머
    'xenos'         = @{ mine = 75; ts = 160; lab = 220; pi = 320; aca = 340 }    # 다양한 행성 보유
    'gleens'        = @{ mine = 75; ts = 160; lab = 200; pi = 320; aca = 340 }    # PI 가이아 -> QIC
    'taklons'       = @{ mine = 75; ts = 160; lab = 200; pi = 320; aca = 340 }    # 브레인스톤
    'ambas'         = @{ mine = 70; ts = 170; lab = 200; pi = 320; aca = 340 }    # PI 스왑
    'bescods'       = @{ mine = 75; ts = 180; lab = 200; pi = 260; aca = 340 }    # 트랙 역방향
    'firaks'        = @{ mine = 70; ts = 160; lab = 220; pi = 300; aca = 340 }    # 연구소 다운그레이드 콤보
    'itars'         = @{ mine = 70; ts = 160; lab = 200; pi = 280; aca = 400 }    # 아카데미 = 4기술타일 엔진
    'nevlas'        = @{ mine = 70; ts = 160; lab = 220; pi = 320; aca = 340 }    # 파워 효율
    'moweyip'       = @{ mine = 70; ts = 170; lab = 200; pi = 280; aca = 340 }
    'space_giants'  = @{ mine = 75; ts = 160; lab = 200; pi = 320; aca = 360 }    # 가이아 강함
    'tinkeroids'    = @{ mine = 70; ts = 180; lab = 200; pi = 280; aca = 340 }
    'darkanians'    = @{ mine = 70; ts = 160; lab = 200; pi = 280; aca = 360 }
}

foreach ($faction in $factionTweaks.Keys) {
    if ($json.byFaction.$faction) {
        $t = $factionTweaks[$faction]
        Set-StructureWeights -block $json.byFaction.$faction -mineBase $t.mine -tsBase $t.ts -labBase $t.lab -piBase $t.pi -acaBase $t.aca
        # 후반 강화 일괄 적용 (팩션별로 조금씩 다르게 유지)
        if ($json.byFaction.$faction.vpWeightLate -lt 22) { $json.byFaction.$faction.vpWeightLate = 22 }
        if ($json.byFaction.$faction.federationValueEach -lt 160) { $json.byFaction.$faction.federationValueEach = 180 }
        if ($json.byFaction.$faction.researchLevel5Bonus -lt 350) { $json.byFaction.$faction.researchLevel5Bonus = 380 }
    }
}

$json | ConvertTo-Json -Depth 10 | Out-File -FilePath $path -Encoding utf8
Write-Output "Updated $path"
