#!/usr/bin/env bash
# Oracle Cloud (Ubuntu 22.04, Ampere A1/ARM64)에서 Gaia Project 서버 셋업.
# 사용: 코드가 /opt/GaiaProjectWeb 에 있는 상태에서  sudo 없이 실행 (내부에서 sudo 사용).
#   cd /opt/GaiaProjectWeb && bash deploy/setup-oracle.sh
set -euo pipefail

APP_DIR=/opt/GaiaProjectWeb
PORT="${PORT:-5000}"

echo "==> [1/5] Node 20 LTS 설치 확인 (ARM64)"
if ! command -v node >/dev/null 2>&1 || { [[ "$(node -v)" != v20* ]] && [[ "$(node -v)" != v22* ]]; }; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y git build-essential
node -v; npm -v

echo "==> [2/5] 의존성 설치 + 빌드"
cd "$APP_DIR"
npm ci
npm run build
test -f dist/index.cjs || { echo "빌드 산출물 dist/index.cjs 없음 — 빌드 실패"; exit 1; }

echo "==> [3/5] 인스턴스 방화벽(iptables)에 포트 ${PORT} 개방"
# Oracle Ubuntu 이미지는 기본 iptables가 SSH 외 인바운드를 REJECT함. REJECT 규칙 앞에 ACCEPT 삽입.
if ! sudo iptables -C INPUT -p tcp --dport "${PORT}" -j ACCEPT 2>/dev/null; then
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport "${PORT}" -j ACCEPT
fi
sudo apt-get install -y iptables-persistent >/dev/null 2>&1 || true
sudo netfilter-persistent save || true
echo "현재 INPUT 규칙:"; sudo iptables -L INPUT --line-numbers | head -12

echo "==> [4/5] systemd 서비스 등록"
sudo cp "$APP_DIR/deploy/gaia.service" /etc/systemd/system/gaia.service
sudo systemctl daemon-reload
sudo systemctl enable --now gaia

echo "==> [5/5] 상태"
sleep 1
sudo systemctl status gaia --no-pager -l | head -15 || true
echo ""
IP=$(curl -s ifconfig.me || echo '<서버공인IP>')
echo "완료. 접속: http://${IP}:${PORT}"
echo "로그: journalctl -u gaia -f"
echo "※ Oracle 콘솔의 VCN Security List 인그레스에도 ${PORT}/TCP 개방 필요(deploy/README.md 참고)."
